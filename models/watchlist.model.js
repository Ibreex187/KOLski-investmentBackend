const mongoose = require('mongoose');


const WatchlistSchema = new mongoose.Schema({
    portfolio_id:{type:mongoose.Schema.Types.ObjectId, ref:'Portfolio', required:true},
    symbol:{type:String, required:true, uppercase:true, trim:true},
    name:{type:String, required:true, trim:true},
    addedAt:{type:Date, default:Date.now},
} , {timestamps:true});

WatchlistSchema.index({portfolio_id:1, symbol:1}, {unique:true});

const WatchlistModel = mongoose.model('Watchlist', WatchlistSchema);

module.exports = WatchlistModel;