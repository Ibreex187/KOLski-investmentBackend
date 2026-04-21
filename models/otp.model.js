const mongoose = require("mongoose");

const otpSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "user"
    },
    email: {
        type: String,
        required: true,
        lowercase: true,
        trim: true
    },
    purpose: {
        type: String,
        enum: ["profile_update", "change_password", "forgot_password"],
        required: true
    },
    otpHash: {
        type: String,
        required: true
    },
    expiresAt: {
        type: Date,
        required: true
    },
    attempts: {
        type: Number,
        default: 0
    },
    maxAttempts: {
        type: Number,
        default: 5
    },
    consumed: {
        type: Boolean,
        default: false
    }
}, { timestamps: true, strict: "throw" });

otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
otpSchema.index({ userId: 1, purpose: 1, consumed: 1, createdAt: -1 });
otpSchema.index({ email: 1, purpose: 1, consumed: 1, createdAt: -1 });

const OtpModel = mongoose.model("otp", otpSchema);

module.exports = OtpModel;
