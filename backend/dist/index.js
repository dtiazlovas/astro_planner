import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import healthRouter from './routes/health.js';
import { closeDatabaseConnection, connectToDatabase } from './db.js';
const app = express();
const PORT = process.env.PORT ?? 5000;
app.use(cors({ origin: process.env.FRONTEND_URL ?? 'http://localhost:3000' }));
app.use(express.json());
app.use('/api/health', healthRouter);
const startServer = async () => {
    try {
        await connectToDatabase();
        console.log('Connected to MSSQL');
        app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
        });
    }
    catch (error) {
        console.error('Failed to connect to MSSQL', error);
        process.exit(1);
    }
};
const shutdown = async () => {
    await closeDatabaseConnection();
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
void startServer();
