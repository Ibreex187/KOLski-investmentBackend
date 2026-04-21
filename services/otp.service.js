const crypto = require("crypto");
const otpGenerator = require("otp-generator");
const OtpModel = require("../models/otp.model");
const { sendOtpEmail } = require("../utils/mailer.js");
const UserModel = require("../models/user.model.js");

const OTP_EXPIRY_MINUTES = Number(process.env.OTP_EXPIRY_MINUTES || 10);
const OTP_REQUEST_WINDOW_MINUTES = Number(process.env.OTP_REQUEST_WINDOW_MINUTES || 15);
const OTP_MAX_REQUESTS_PER_WINDOW = Number(process.env.OTP_MAX_REQUESTS_PER_WINDOW || 3);
const OTP_MIN_RESEND_SECONDS = Number(process.env.OTP_MIN_RESEND_SECONDS || 60);

const generateOtpCode = () => {
    return otpGenerator.generate(6, {
        upperCaseAlphabets: false,
        lowerCaseAlphabets: false,
        specialChars: false,
        digits: true
    });
};

const hashOtp = (otp) => {
    return crypto.createHash("sha256").update(String(otp)).digest("hex");
};

const issueOtp = async ({ userId, email, purpose }) => {
    const normalizedEmail = String(email).trim().toLowerCase();

    const scope = userId ? { userId } : { email: normalizedEmail };
    const now = new Date();
    const windowStart = new Date(now.getTime() - OTP_REQUEST_WINDOW_MINUTES * 60 * 1000);

    const [requestsInWindow, latestOtp] = await Promise.all([
        OtpModel.countDocuments({
            purpose,
            ...scope,
            createdAt: { $gte: windowStart }
        }),
        OtpModel.findOne({ purpose, ...scope }).sort({ createdAt: -1 })
    ]);

    if (requestsInWindow >= OTP_MAX_REQUESTS_PER_WINDOW) {
        const error = new Error(`Too many OTP requests. Try again in ${OTP_REQUEST_WINDOW_MINUTES} minutes`);
        error.statusCode = 429;
        throw error;
    }

    if (latestOtp) {
        const secondsSinceLastOtp = (now.getTime() - new Date(latestOtp.createdAt).getTime()) / 1000;
        if (secondsSinceLastOtp < OTP_MIN_RESEND_SECONDS) {
            const secondsLeft = Math.ceil(OTP_MIN_RESEND_SECONDS - secondsSinceLastOtp);
            const error = new Error(`Please wait ${secondsLeft} seconds before requesting another OTP`);
            error.statusCode = 429;
            throw error;
        }
    }

    await OtpModel.updateMany(
        {
            purpose,
            consumed: false,
            ...scope
        },
        { $set: { consumed: true } }
    );

    const otpCode = generateOtpCode();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    await OtpModel.create({
        userId,
        email: normalizedEmail,
        purpose,
        otpHash: hashOtp(otpCode),
        expiresAt
    });

    // Fetch user's name if userId is provided
    let userName = '';
    if (userId) {
        const user = await UserModel.findById(userId);
        if (user) userName = user.name;
    }

    // Send OTP email (do not block response)
    sendOtpEmail(normalizedEmail, userName, otpCode, purpose).catch(() => null);

    return otpCode;
};

const verifyOtp = async ({ userId, email, purpose, otp }) => {
    const now = new Date();
    const normalizedEmail = String(email).trim().toLowerCase();

    const otpRecord = await OtpModel.findOne({
        purpose,
        consumed: false,
        expiresAt: { $gt: now },
        ...(userId ? { userId } : { email: normalizedEmail })
    }).sort({ createdAt: -1 });

    if (!otpRecord) {
        return { valid: false, message: "OTP is invalid or expired" };
    }

    if (otpRecord.attempts >= otpRecord.maxAttempts) {
        otpRecord.consumed = true;
        await otpRecord.save();
        return { valid: false, message: "OTP attempt limit exceeded. Request a new OTP" };
    }

    const hashedInput = hashOtp(otp);
    if (hashedInput !== otpRecord.otpHash) {
        otpRecord.attempts += 1;
        if (otpRecord.attempts >= otpRecord.maxAttempts) {
            otpRecord.consumed = true;
        }
        await otpRecord.save();
        return { valid: false, message: "Invalid OTP" };
    }

    otpRecord.consumed = true;
    await otpRecord.save();

    return { valid: true };
};

module.exports = {
    issueOtp,
    verifyOtp,
    OTP_EXPIRY_MINUTES,
    OTP_REQUEST_WINDOW_MINUTES,
    OTP_MAX_REQUESTS_PER_WINDOW,
    OTP_MIN_RESEND_SECONDS
};
