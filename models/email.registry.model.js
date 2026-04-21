const mongoose = require("mongoose");

const EmailRegistrySchema = new mongoose.Schema(
    {
        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true
        },
        firstUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "user",
            required: true
        }
    },
    { timestamps: true, strict: "throw" }
);

const EmailRegistryModel = mongoose.model("email_registry", EmailRegistrySchema);

module.exports = EmailRegistryModel;