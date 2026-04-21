const mongoose = require('mongoose');

const HoldingSchema = new mongoose.Schema({
    portfolio_id:{type:mongoose.Schema.Types.ObjectId, ref:'Portfolio', required:true},
    symbol:{type:String, required:true, uppercase:true, trim:true},
    name:{type:String, required:true, trim:true},
    shares:{type:Number, required:true, min:0},
    average_price:{type:Number, required:true, min:0},
    sector:{type:String, trim:true},
    market_value:{type:Number, default:0, min:0},
    logo_url:{type:String, default:''},

}, {timestamps:true});

HoldingSchema.index({portfolio_id:1, symbol:1}, {unique:true});

const HoldingModel = mongoose.model('Holding', HoldingSchema);     

module.exports = HoldingModel; 