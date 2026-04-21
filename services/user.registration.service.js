const { randomUUID } = require('crypto');
const UserModel = require('../models/user.model.js');
const PortfolioModel = require('../models/portfolio.model.js');
const EmailRegistryModel = require('../models/email.registry.model');
const { createSessionForUser } = require('./auth.service.js');

const EMAIL_VERIFICATION_TOKEN_TTL_HOURS = Number(process.env.EMAIL_VERIFICATION_TOKEN_TTL_HOURS || 24);

async function registerUser({ name, username, email, password }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();

  const alreadyRegistered = await EmailRegistryModel.findOne({ email: normalizedEmail });
  if (alreadyRegistered) {
    throw new Error('Email already registered');
  }

  const existingUser = await UserModel.findOne({ email: normalizedEmail });
  if (existingUser) {
    throw new Error('Email already in use');
  }

  const emailVerificationToken = randomUUID();

  const user = await UserModel.create({
    name,
    username,
    email: normalizedEmail,
    password,
    emailVerificationToken,
    emailVerificationExpires: new Date(Date.now() + (EMAIL_VERIFICATION_TOKEN_TTL_HOURS * 60 * 60 * 1000)),
  });

  await EmailRegistryModel.create({ email: normalizedEmail, firstUserId: user._id });
  await PortfolioModel.create({ user_id: user._id, holdings: [] });

  const session = await createSessionForUser(user, { deviceName: 'registration' });

  return {
    token: session.token,
    refreshToken: session.refreshToken,
    verificationToken: emailVerificationToken,
    user: session.user,
  };
}

module.exports = { registerUser };
