
const { randomUUID } = require('crypto');
const { registerUser } = require('../services/user.registration.service.js');
const {
  createSessionForUser,
  rotateRefreshSession,
  revokeSessionByRefreshToken,
  revokeAllSessionsForUser,
  revokeSessionById,
  listActiveSessionsForUser,
} = require('../services/auth.service.js');
const { sendWelcomeEmail, sendOtpEmail, sendVerificationEmail } = require('../utils/mailer.js');
const UserModel = require('../models/user.model.js');
const { issueOtp, verifyOtp, OTP_EXPIRY_MINUTES } = require('../services/otp.service.js');
const jwt = require('jsonwebtoken');

const FORGOT_PASSWORD_RESET_TOKEN_TTL_MINUTES = Number(process.env.FORGOT_PASSWORD_RESET_TOKEN_TTL_MINUTES || 15);
const EMAIL_VERIFICATION_TOKEN_TTL_HOURS = Number(process.env.EMAIL_VERIFICATION_TOKEN_TTL_HOURS || 24);

const getRequestSessionMeta = (req) => ({
  deviceName: req.get('x-device-name') || 'unknown-device',
  userAgent: req.get('user-agent') || '',
  ipAddress: String(req.headers['x-forwarded-for'] || req.ip || req.socket?.remoteAddress || '').split(',')[0].trim(),
});

const register = async (req, res) => {
    try {
        const { name, username, email, password } = req.body;
        const { token, refreshToken, user, verificationToken } = await registerUser({ name, username, email, password });

        res.status(201).json({
            success: true,
            message: 'Registration successful. Please verify your email before logging in.',
            requiresEmailVerification: !user.isVerified,
            token,
            refreshToken,
            user,
        });

        sendWelcomeEmail(user.email, user.name, user.username).catch(() => null);

        if (!user.isVerified && verificationToken) {
            sendVerificationEmail(user.email, user.name, verificationToken).catch(() => null);
        }
    } catch (err) {
        console.error('Register controller error:', err);
        if (['Email already in use', 'Email already registered'].includes(err.message)) {
            return res.status(400).json({ error: err.message });
        }

        return res.status(500).json({ error: err.message });
    }
};

const login = async (req, res) => {
  try {
    const normalizedEmail = String(req.body.email || '').trim().toLowerCase();
    const { password } = req.body;
    const user = await UserModel.findOne({ email: normalizedEmail }).select('+password +refreshToken +refreshTokenExpires +emailVerificationToken +emailVerificationExpires');

    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    if (!user.isVerified) {
      return res.status(403).json({
        success: false,
        message: 'Please verify your email before logging in',
        requiresEmailVerification: true,
      });
    }

    user.lastLogin = Date.now();
    const session = await createSessionForUser(user, getRequestSessionMeta(req));

    return res.json({
      success: true,
      token: session.token,
      refreshToken: session.refreshToken,
      user: session.user,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

const getMe = async (req, res) => {
  try {
    const userId = req.user._id;
    const foundUser = await UserModel.findById(userId).select('-password -refreshToken -emailVerificationToken');

    if (!foundUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.status(200).json({
      success: true,
      message: 'User details retrieved successfully',
      data: {
        id: foundUser._id,
        name: foundUser.name,
        username: foundUser.username,
        email: foundUser.email,
        cash_balance: foundUser.cash_balance,
        currency: foundUser.currency,
        lastLogin: foundUser.lastLogin,
        role: foundUser.role,
        isVerified: foundUser.isVerified,
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve user details',
      error: error.message,
    });
  }
};

const sendVerification = async (req, res) => {
  try {
    const normalizedEmail = String(req.body.email || '').trim().toLowerCase();
    const foundUser = await UserModel.findOne({ email: normalizedEmail }).select('+emailVerificationToken +emailVerificationExpires');

    if (!foundUser) {
      return res.status(200).json({
        success: true,
        message: 'If the email exists, a verification email has been sent'
      });
    }

    if (foundUser.isVerified) {
      return res.status(200).json({
        success: true,
        message: 'Email is already verified'
      });
    }

    const verificationToken = randomUUID();
    foundUser.emailVerificationToken = verificationToken;
    foundUser.emailVerificationExpires = new Date(Date.now() + (EMAIL_VERIFICATION_TOKEN_TTL_HOURS * 60 * 60 * 1000));
    await foundUser.save({ validateBeforeSave: false });

    await sendVerificationEmail(foundUser.email, foundUser.name, verificationToken);

    return res.status(200).json({
      success: true,
      message: `Verification email sent. Token expires in ${EMAIL_VERIFICATION_TOKEN_TTL_HOURS} hours`
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Error sending verification email'
    });
  }
};

const verifyEmail = async (req, res) => {
  try {
    const { token } = req.body;
    const foundUser = await UserModel.findOne({ emailVerificationToken: token }).select('+emailVerificationToken +emailVerificationExpires +refreshToken +refreshTokenExpires');

    if (!foundUser || !foundUser.emailVerificationExpires || foundUser.emailVerificationExpires < new Date()) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired verification token'
      });
    }

    foundUser.isVerified = true;
    foundUser.emailVerificationToken = null;
    foundUser.emailVerificationExpires = null;

    const session = await createSessionForUser(foundUser, getRequestSessionMeta(req));

    return res.status(200).json({
      success: true,
      message: 'Email verified successfully',
      data: {
        token: session.token,
        refreshToken: session.refreshToken,
        user: session.user,
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Error verifying email'
    });
  }
};

const refreshAccessToken = async (req, res) => {
  try {
    const incomingRefreshToken = String(req.body.refreshToken || '').trim();
    const session = await rotateRefreshSession(incomingRefreshToken, getRequestSessionMeta(req));

    return res.status(200).json({
      success: true,
      message: 'Token refreshed successfully',
      data: {
        token: session.token,
        refreshToken: session.refreshToken,
      }
    });
  } catch (error) {
    const message = error.message || 'Error refreshing token';
    const status = /refresh token|user not found/i.test(message) ? 401 : 500;
    return res.status(status).json({
      success: false,
      message,
    });
  }
};

const logout = async (req, res) => {
  try {
    const incomingRefreshToken = String(req.body.refreshToken || '').trim();
    await revokeSessionByRefreshToken(incomingRefreshToken);

    return res.status(200).json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    return res.status(200).json({
      success: true,
      message: 'Logged out successfully'
    });
  }
};

const logoutAll = async (req, res) => {
  try {
    await revokeAllSessionsForUser(req.user._id);
    return res.status(200).json({
      success: true,
      message: 'All sessions logged out successfully'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Error logging out all sessions'
    });
  }
};

const listSessions = async (req, res) => {
  try {
    const sessions = await listActiveSessionsForUser(req.user._id);
    return res.status(200).json({
      success: true,
      data: sessions,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Error listing sessions'
    });
  }
};

const revokeSession = async (req, res) => {
  try {
    const revoked = await revokeSessionById(req.user._id, req.params.id);
    if (!revoked) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Session revoked successfully'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Error revoking session'
    });
  }
};

const requestForgotPasswordotp = async (req, res) => {
    try {
        const normalizedEmail = String(req.body.email || '').trim().toLowerCase();

        if (!normalizedEmail) {
            return res.status(400).send({
                success: false,
                message: 'Email is required'
            });
        }

        const foundUser = await UserModel.findOne({ email: normalizedEmail });

        if (foundUser) {
            const otp = await issueOtp({
                userId: foundUser._id,
                email: foundUser.email,
                purpose: 'forgot_password'
            });

            await sendOtpEmail(
                foundUser.email,
                `${foundUser.name} ${foundUser.username ? `(${foundUser.username})` : ''}`,
                otp,
                'forgot password reset'
            );
        }

        return res.status(200).json({
            success: true,
            message: `If the email exists, an OTP has been sent. It expires in ${OTP_EXPIRY_MINUTES} minutes`
        });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({
                success: false,
                message: error.message
            });
        }

        return res.status(500).send({
            success: false,
            message: 'Error sending forgot password OTP'
        });
    }
};

const verifyForgotPasswordotp = async (req, res) => {
    try {
        const normalizedEmail = String(req.body.email || '').trim().toLowerCase();
        const { otp } = req.body;

        if (!normalizedEmail) {
            return res.status(400).send({
                success: false,
                message: 'Email is required'
            });
        }

        const foundUser = await UserModel.findOne({ email: normalizedEmail });
        if (!foundUser) {
            return res.status(400).json({
                success: false,
                message: 'Invalid OTP or email'
            });
        }

        const otpVerification = await verifyOtp({
            userId: foundUser._id,
            email: foundUser.email,
            purpose: 'forgot_password',
            otp
        });

        if (!otpVerification.valid) {
            return res.status(400).send({
                success: false,
                message: otpVerification.message
            });
        }

        const resetToken = jwt.sign(
            {
                userId: foundUser._id,
                email: foundUser.email,
                purpose: 'forgot_password_reset'
            },
            process.env.JWT_SECRET,
            { expiresIn: `${FORGOT_PASSWORD_RESET_TOKEN_TTL_MINUTES}m` }
        );

        return res.status(200).json({
            success: true,
            message: 'OTP verified successfully',
            data: {
                resetToken,
                expiresInMinutes: FORGOT_PASSWORD_RESET_TOKEN_TTL_MINUTES
            }
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Error verifying forgot password OTP'
        });
    }
};

const resetForgotPassword = async (req, res) => {
    try {
        const { resetToken, newPassword, confirmPassword } = req.body;

        if (newPassword !== confirmPassword) {
            return res.status(400).json({
                success: false,
                message: 'Password confirmation does not match'
            });
        }

        let decodedToken;
        try {
            decodedToken = jwt.verify(resetToken, process.env.JWT_SECRET);
        } catch (error) {
            return res.status(400).json({
                success: false,
                message: 'Invalid or expired reset token'
            });
        }

        if (decodedToken.purpose !== 'forgot_password_reset') {
            return res.status(400).json({
                success: false,
                message: 'Invalid reset token'
            });
        }

        const foundUser = await UserModel.findById(decodedToken.userId);
        if (!foundUser || foundUser.email !== String(decodedToken.email || '').trim().toLowerCase()) {
            return res.status(400).json({
                success: false,
                message: 'Invalid reset token'
            });
        }

        foundUser.password = newPassword;
        await foundUser.save();

        return res.status(200).json({
            success: true,
            message: 'Password reset successful'
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Error resetting password'
        });
    }
};

module.exports = {
    register,
    login,
    getMe,
    sendVerification,
    verifyEmail,
    refreshToken: refreshAccessToken,
    logout,
    logoutAll,
    listSessions,
    revokeSession,
    requestForgotPasswordotp,
    verifyForgotPasswordotp,
    resetForgotPassword
};