const mongoose = require("mongoose");

mongoose.set('bufferCommands', false);
mongoose.set('bufferTimeoutMS', 1000);

let cachedConnection = null;
let connectingPromise = null;

function isDatabaseConnected() {
    return mongoose.connection.readyState === 1;
}

async function connectToDatabase() {
    if (cachedConnection && isDatabaseConnected()) {
        return cachedConnection;
    }

    if (connectingPromise) {
        return connectingPromise;
    }

    if (!process.env.DATABASE_URI) {
        throw new Error("DATABASE_URI is not configured");
    }

    const serverSelectionTimeoutMS = Number(process.env.DB_SERVER_SELECTION_TIMEOUT_MS || 5000);

    connectingPromise = mongoose.connect(process.env.DATABASE_URI, {
        serverSelectionTimeoutMS,
    })
        .then((connection) => {
            cachedConnection = connection;
            return cachedConnection;
        })
        .finally(() => {
            connectingPromise = null;
        });

    return connectingPromise;
}

module.exports = { connectToDatabase, isDatabaseConnected };
