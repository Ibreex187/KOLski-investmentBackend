const mongoose = require('mongoose');
const PortfolioModel = require('./models/portfolio.model');
const { connectToDatabase } = require('./utils/db');

async function checkPortfolio(userId) {
  await connectToDatabase();
  try {
    const portfolio = await PortfolioModel.findOne({ user_id: userId });
    if (portfolio) {
      console.log('Portfolio found:', portfolio);
    } else {
      console.log('No portfolio found for user_id:', userId);
    }
  } catch (err) {
    console.error('Error checking portfolio:', err);
  } finally {
    await mongoose.disconnect();
  }
}

const userId = process.argv[2] || process.env.CHECK_PORTFOLIO_USER_ID;

if (!userId) {
  console.error('Usage: node check_portfolio.js <userId>');
  process.exit(1);
}

checkPortfolio(userId);
