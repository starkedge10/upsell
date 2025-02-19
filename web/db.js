import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
    ssl: {
        rejectUnauthorized: false // Required for Heroku PostgreSQL
    }
});

// ✅ Check Database Connection
const checkDBConnection = async () => {
    try {
        const client = await pool.connect();
        console.log('✅ Database connection successful');
        client.release();
    } catch (err) {
        console.error('❌ Database connection failed:', err.message);
    }
};

// Call the function on startup
checkDBConnection();

// Handle unexpected errors
pool.on('error', (err) => {
    console.error('Unexpected error on idle client:', err);
    process.exit(-1);
});

export const query = async (sql, params) => {
    const client = await pool.connect();
    try {
        const result = await client.query(sql, params);
        return result; // Return full query result instead of only result.rows
    } finally {
        client.release();
    }
};

// Helper function for single-row queries (if needed)
export const querySingle = async (sql, params) => {
    const result = await query(sql, params);
    return result.rows[0]; // Return only the first row
};
