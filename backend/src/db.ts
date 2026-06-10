import sql from 'mssql'

const toBool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback
  return value.toLowerCase() === 'true'
}

const toNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value)
  return Number.isNaN(parsed) ? fallback : parsed
}

const buildConfig = (): sql.config => {
  const shared: sql.config = {
    server: process.env.MSSQL_SERVER ?? 'localhost',
    port: toNumber(process.env.MSSQL_PORT, 1433),
    database: process.env.MSSQL_DATABASE ?? 'master',
    options: {
      encrypt: toBool(process.env.MSSQL_ENCRYPT, false),
      trustServerCertificate: toBool(process.env.MSSQL_TRUST_SERVER_CERTIFICATE, true)
    }
  }

  if (process.env.MSSQL_DOMAIN) {
    return {
      ...shared,
      authentication: {
        type: 'ntlm',
        options: {
          domain: process.env.MSSQL_DOMAIN,
          userName: process.env.MSSQL_USER ?? '',
          password: process.env.MSSQL_PASSWORD ?? ''
        }
      }
    }
  }

  return { ...shared, user: process.env.MSSQL_USER, password: process.env.MSSQL_PASSWORD }
}

let poolPromise: Promise<sql.ConnectionPool> | null = null

export const connectToDatabase = async (): Promise<sql.ConnectionPool> => {
  if (!poolPromise) {
    const pool = new sql.ConnectionPool(buildConfig())
    poolPromise = pool.connect()
  }

  return poolPromise
}

export const closeDatabaseConnection = async (): Promise<void> => {
  if (!poolPromise) return

  const pool = await poolPromise
  await pool.close()
  poolPromise = null
}
