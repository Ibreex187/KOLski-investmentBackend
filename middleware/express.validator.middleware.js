

const { validationResult } = require('express-validator');

const validate = (req, res, next) => {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
        const messages = errors.array().map(error => ({
            field: error.param,
            message: error.msg
        }));

        return res.status(400).send({
            success: false,
            message: "Validation failed",
            errors: messages
        });
    }

    next();
};

module.exports = validate;