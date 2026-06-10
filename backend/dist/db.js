import sql from 'mssql';
const toBool = (value, fallback) => {
    if (value === undefined)
        return fallback;
    return value.toLowerCase() === 'true';
};
const toNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? fallback : parsed;
};
const dbConfig = {
    server: process.env.MSSQL_SERVER ?? 'localhost',
    port: toNumber(process.env.MSSQL_PORT, 1433),
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    database: process.env.MSSQL_DATABASE ?? 'master',
    options: {
        encrypt: toBool(process.env.MSSQL_ENCRYPT, false),
        trustServerCertificate: toBool(process.env.MSSQL_TRUST_SERVER_CERTIFICATE, true)
    }
};
let poolPromise = null;
export const connectToDatabase = async () => {
    if (!poolPromise) {
        const pool = new sql.ConnectionPool(dbConfig);
        poolPromise = pool.connect();
    }
    return poolPromise;
};
export const closeDatabaseConnection = async () => {
    if (!poolPromise)
        return;
    const pool = await poolPromise;
    await pool.close();
    poolPromise = null;
};
