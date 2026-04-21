const mongoose = require('mongoose');
const userModel = require('./user.model');

const PortfoliioSchema = new mongoose.Schema({
    user_id:{type:mongoose.Schema.Types.ObjectId, ref:'User', required:true, unique:true},
    name:{type:String, required:true, trim:true, default:'My Portfolio'},
    currency:{type:String, default:'USD'},
    cash_balance:{type:Number, default:0, min:0},
    total_deposited:{type:Number, default:0, min:0},
    total_withdrawn:{type:Number, default:0, min:0},
    total_value:{type:Number, default:0, min:0},
    profit_loss:{type:Number, default:0},
    profit_loss_percent:{type:Number, default:0},
    last_updated:{type:Date, default:Date.now},
    performance:{
        realized_pnl:{type:Number, default:0},
        unrealized_pnl:{type:Number, default:0},
        total_return_pct:{type:Number, default:0},
    },
    is_active:{type:Boolean, default:true},

} , {timestamps:true, toJSON:{virtuals:true}, toObject:{virtuals:true}});  

const PortfolioModel = mongoose.model('Portfolio', PortfoliioSchema);

module.exports = PortfolioModel; 