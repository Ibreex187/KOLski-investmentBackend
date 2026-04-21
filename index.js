const dotenv = require('dotenv');
dotenv.config({ quiet: true });

const app = require('./app');
const { startAlertWorker } = require('./services/alert.service');
const { connectToDatabase, isDatabaseConnected } = require('./utils/db');

const PORT = process.env.PORT || 4040;
const allowStartupWithoutDb = process.env.ALLOW_START_WITHOUT_DB === 'true';
let alertWorker = null;
let server = null;

async function bootstrap() {
    let databaseConnected = false;

    try {
        await connectToDatabase();
        databaseConnected = true;
        console.log('database connected successfully');
    } catch (error) {
        if (!allowStartupWithoutDb) {
            console.log('failed to connect to db', error);
            process.exit(1);
        }

        console.warn('database connection failed, continuing in degraded mode because ALLOW_START_WITHOUT_DB=true');
        console.warn(error.message);
    }

    if (databaseConnected && isDatabaseConnected()) {
        alertWorker = startAlertWorker();
    } else {
        console.warn('alert worker disabled until database connectivity is restored');
    }

    server = app.listen(PORT, () => {
        console.log(`server started successfully on port ${PORT}${databaseConnected ? '' : ' (degraded mode)'}`);
    });

    server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            console.error(`server failed to start: port ${PORT} is already in use`);
            process.exit(1);
        }
        console.error('server failed to start', error);
        process.exit(1);
    });
}

bootstrap();

process.on('SIGINT', () => {
    if (alertWorker?.stop) {
        alertWorker.stop();
    }
    if (server) {
        server.close(() => process.exit(0));
        return;
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    if (alertWorker?.stop) {
        alertWorker.stop();
    }
    if (server) {
        server.close(() => process.exit(0));
        return;
    }
    process.exit(0);
});