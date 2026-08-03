const sqlite3 = require('sqlite3').verbose();
const mysql = require('mysql2/promise');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Determine serverless/read-only environment
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);

// Determine SQLite storage location safely
const defaultSqlitePath = isServerless 
    ? path.join('/tmp', 'expenses.db') 
    : path.join(__dirname, '../../data/expenses.db');

// Ensure parent directory exists for SQLite
try {
    const dir = path.dirname(defaultSqlitePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
} catch (err) {
    console.warn('⚠️ Could not create SQLite directory:', err.message);
}

// Database configuration
const DB_CONFIG = {
    type: (process.env.DATABASE_URL || process.env.POSTGRES_URL) ? 'postgresql' : (process.env.DB_TYPE || 'sqlite'),
    sqlite: {
        path: process.env.SQLITE_PATH || defaultSqlitePath
    },
    mysql: {
        host: process.env.MYSQL_HOST || 'localhost',
        port: parseInt(process.env.MYSQL_PORT, 10) || 3306,
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD || '',
        database: process.env.MYSQL_DATABASE || 'expense_tracker',
        connectionLimit: 10
    },
    postgresql: {
        connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL,
        host: process.env.PG_HOST || 'localhost',
        port: parseInt(process.env.PG_PORT, 10) || 5432,
        user: process.env.PG_USER || 'postgres',
        password: process.env.PG_PASSWORD || '',
        database: process.env.PG_DATABASE || 'expense_tracker',
        max: 10,
        ssl: (process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NODE_ENV === 'production') 
            ? { rejectUnauthorized: false } 
            : false
    }
};

class DatabaseManager {
    constructor() {
        this.db = null;
        this.type = DB_CONFIG.type;
        this.isInitialized = false;
        this.ready = this.initializeDatabase();
    }

    async initializeDatabase() {
        try {
            console.log(`🔌 Initializing database [Type: ${this.type.toUpperCase()}]...`);
            switch (this.type) {
                case 'sqlite':
                    await this.initializeSQLite();
                    break;
                case 'mysql':
                    await this.initializeMySQL();
                    break;
                case 'postgresql':
                    await this.initializePostgreSQL();
                    break;
                default:
                    throw new Error(`Unsupported database type: ${this.type}`);
            }
            console.log(`✅ Connected to ${this.type.toUpperCase()} database`);
            await this.createTables();
            this.isInitialized = true;
        } catch (error) {
            console.error('❌ Database initialization failed:', error.message);
            if (this.type !== 'sqlite') {
                console.log('🔄 Falling back to SQLite in /tmp...');
                this.type = 'sqlite';
                DB_CONFIG.sqlite.path = path.join('/tmp', 'expenses.db');
                await this.initializeSQLite();
                await this.createTables();
                this.isInitialized = true;
            } else {
                throw error;
            }
        }
    }

    async initializeSQLite() {
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(DB_CONFIG.sqlite.path, (err) => {
                if (err) {
                    console.error('SQLite connection error:', err);
                    reject(err);
                } else {
                    console.log(`SQLite database open at: ${DB_CONFIG.sqlite.path}`);
                    resolve();
                }
            });
        });
    }

    async initializeMySQL() {
        this.db = await mysql.createConnection(DB_CONFIG.mysql);
        console.log('MySQL connection established');
    }

    async initializePostgreSQL() {
        if (DB_CONFIG.postgresql.connectionString) {
            this.db = new Pool({
                connectionString: DB_CONFIG.postgresql.connectionString,
                ssl: DB_CONFIG.postgresql.ssl
            });
        } else {
            this.db = new Pool(DB_CONFIG.postgresql);
        }
        // Verify connection
        const client = await this.db.connect();
        client.release();
        console.log('PostgreSQL connection pool verified');
    }

    async createTables() {
        const createUsersSQL = `
            CREATE TABLE IF NOT EXISTS users (
                id ${this.type === 'postgresql' ? 'VARCHAR(255) PRIMARY KEY' : 
                    this.type === 'mysql' ? 'VARCHAR(255) PRIMARY KEY' : 
                    'TEXT PRIMARY KEY'},
                email ${this.type === 'postgresql' ? 'VARCHAR(255) UNIQUE NOT NULL' : 
                    this.type === 'mysql' ? 'VARCHAR(255) UNIQUE NOT NULL' : 
                    'TEXT UNIQUE NOT NULL'},
                name ${this.type === 'postgresql' ? 'VARCHAR(255) NOT NULL' : 
                    this.type === 'mysql' ? 'VARCHAR(255) NOT NULL' : 
                    'TEXT NOT NULL'},
                password_hash ${this.type === 'postgresql' ? 'TEXT' : 
                    this.type === 'mysql' ? 'TEXT' : 
                    'TEXT'},
                monthly_budget ${this.type === 'postgresql' ? 'DECIMAL(10,2) DEFAULT 5000' : 
                    this.type === 'mysql' ? 'DECIMAL(10,2) DEFAULT 5000' : 
                    'REAL DEFAULT 5000'},
                created_at ${this.type === 'postgresql' ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 
                    this.type === 'mysql' ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 
                    'DATETIME DEFAULT CURRENT_TIMESTAMP'}
            )
        `;

        const createExpensesSQL = `
            CREATE TABLE IF NOT EXISTS expenses (
                id ${this.type === 'postgresql' ? 'SERIAL PRIMARY KEY' : 
                    this.type === 'mysql' ? 'INT AUTO_INCREMENT PRIMARY KEY' : 
                    'INTEGER PRIMARY KEY AUTOINCREMENT'},
                user_id ${this.type === 'postgresql' ? 'VARCHAR(255)' : 
                    this.type === 'mysql' ? 'VARCHAR(255)' : 
                    'TEXT'} NOT NULL,
                date ${this.type === 'postgresql' ? 'DATE' : 'TEXT'} NOT NULL,
                category ${this.type === 'postgresql' ? 'VARCHAR(100)' : 'TEXT'} NOT NULL,
                amount ${this.type === 'postgresql' ? 'DECIMAL(10,2)' : 'REAL'} NOT NULL,
                description ${this.type === 'postgresql' ? 'TEXT' : 'TEXT'},
                created_at ${this.type === 'postgresql' ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 
                    this.type === 'mysql' ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 
                    'DATETIME DEFAULT CURRENT_TIMESTAMP'}
            )
        `;
        
        try {
            if (this.type === 'sqlite') {
                await this.runSQLite(createUsersSQL);
                await this.runSQLite(createExpensesSQL);
            } else if (this.type === 'mysql') {
                await this.db.execute(createUsersSQL);
                await this.db.execute(createExpensesSQL);
            } else if (this.type === 'postgresql') {
                await this.db.query(createUsersSQL);
                await this.db.query(createExpensesSQL);
            }
            console.log('📊 Database tables created/verified');
        } catch (error) {
            console.error('Error creating tables:', error.message);
        }
    }

    // ---- User Operations ----
    async createUser(user) {
        await this.ready;
        try {
            const userId = user.userId || user.id;
            const passwordHash = user.passwordHash || user.password_hash || null;

            if (this.type === 'sqlite') {
                return new Promise((resolve, reject) => {
                    const stmt = this.db.prepare(`INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)`);
                    stmt.run([userId, user.email, user.name, passwordHash], function(err) {
                        if (err) return reject(err);
                        resolve({
                            id: userId,
                            userId: userId,
                            email: user.email,
                            name: user.name
                        });
                    });
                    stmt.finalize();
                });
            } else if (this.type === 'mysql') {
                await this.db.execute(
                    "INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)",
                    [userId, user.email, user.name, passwordHash]
                );
                return { id: userId, userId, email: user.email, name: user.name };
            } else if (this.type === 'postgresql') {
                await this.db.query(
                    "INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)",
                    [userId, user.email, user.name, passwordHash]
                );
                return { id: userId, userId, email: user.email, name: user.name };
            }
        } catch (error) {
            console.error('createUser DB error:', error.message);
            throw error;
        }
    }

    async getUserByEmail(email) {
        await this.ready;
        try {
            const normalizedEmail = (email || '').trim().toLowerCase();
            if (this.type === 'sqlite') {
                return new Promise((resolve, reject) => {
                    this.db.get("SELECT * FROM users WHERE LOWER(email) = LOWER(?)", [normalizedEmail], (err, row) => {
                        if (err) reject(err); else resolve(row || null);
                    });
                });
            } else if (this.type === 'mysql') {
                const [rows] = await this.db.execute("SELECT * FROM users WHERE LOWER(email) = LOWER(?)", [normalizedEmail]);
                return rows[0] || null;
            } else if (this.type === 'postgresql') {
                const result = await this.db.query("SELECT * FROM users WHERE LOWER(email) = LOWER($1)", [normalizedEmail]);
                return result.rows[0] || null;
            }
        } catch (error) {
            console.error('getUserByEmail DB error:', error.message);
            throw error;
        }
    }

    async updateUserBudget(userId, budget) {
        await this.ready;
        try {
            if (this.type === 'sqlite') {
                return new Promise((resolve, reject) => {
                    const stmt = this.db.prepare("UPDATE users SET monthly_budget = ? WHERE id = ?");
                    stmt.run([budget, userId], function(err) {
                        if (err) reject(err); else resolve();
                    });
                    stmt.finalize();
                });
            } else if (this.type === 'mysql') {
                await this.db.execute("UPDATE users SET monthly_budget = ? WHERE id = ?", [budget, userId]);
            } else if (this.type === 'postgresql') {
                await this.db.query("UPDATE users SET monthly_budget = $1 WHERE id = $2", [budget, userId]);
            }
        } catch (error) {
            console.error('updateUserBudget error:', error.message);
            throw error;
        }
    }

    async getUserBudget(userId) {
        await this.ready;
        try {
            if (this.type === 'sqlite') {
                return new Promise((resolve, reject) => {
                    this.db.get("SELECT monthly_budget FROM users WHERE id = ?", [userId], (err, row) => {
                        if (err) reject(err); else resolve(row ? row.monthly_budget : 5000);
                    });
                });
            } else if (this.type === 'mysql') {
                const [rows] = await this.db.execute("SELECT monthly_budget FROM users WHERE id = ?", [userId]);
                return rows[0] ? parseFloat(rows[0].monthly_budget) : 5000;
            } else if (this.type === 'postgresql') {
                const result = await this.db.query("SELECT monthly_budget FROM users WHERE id = $1", [userId]);
                return result.rows[0] ? parseFloat(result.rows[0].monthly_budget) : 5000;
            }
        } catch (error) {
            console.error('getUserBudget error:', error.message);
            return 5000;
        }
    }

    // ---- Expense Operations ----
    async addExpense(expense) {
        await this.ready;
        try {
            if (this.type === 'sqlite') {
                return new Promise((resolve, reject) => {
                    const stmt = this.db.prepare(`
                        INSERT INTO expenses (date, category, amount, description, user_id)
                        VALUES (?, ?, ?, ?, ?)
                    `);
                    stmt.run([expense.date, expense.category, expense.amount, expense.description, expense.user_id], function(err) {
                        if (err) {
                            reject(err);
                        } else {
                            resolve({ id: this.lastID, ...expense });
                        }
                    });
                    stmt.finalize();
                });
            } else if (this.type === 'mysql') {
                const [result] = await this.db.execute(
                    "INSERT INTO expenses (date, category, amount, description, user_id) VALUES (?, ?, ?, ?, ?)",
                    [expense.date, expense.category, expense.amount, expense.description, expense.user_id]
                );
                return { id: result.insertId, ...expense };
            } else if (this.type === 'postgresql') {
                const result = await this.db.query(
                    "INSERT INTO expenses (date, category, amount, description, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id",
                    [expense.date, expense.category, expense.amount, expense.description, expense.user_id]
                );
                return { id: result.rows[0].id, ...expense };
            }
        } catch (error) {
            console.error('addExpense error:', error.message);
            throw error;
        }
    }

    async getAllExpenses(userId) {
        await this.ready;
        try {
            if (this.type === 'sqlite') {
                return new Promise((resolve, reject) => {
                    this.db.all("SELECT * FROM expenses WHERE user_id = ? ORDER BY date DESC", [userId], (err, rows) => {
                        if (err) reject(err); else resolve(rows || []);
                    });
                });
            } else if (this.type === 'mysql') {
                const [rows] = await this.db.execute("SELECT * FROM expenses WHERE user_id = ? ORDER BY date DESC", [userId]);
                return rows || [];
            } else if (this.type === 'postgresql') {
                const result = await this.db.query("SELECT * FROM expenses WHERE user_id = $1 ORDER BY date DESC", [userId]);
                return result.rows || [];
            }
        } catch (error) {
            console.error('getAllExpenses error:', error.message);
            throw error;
        }
    }

    async getExpensesByMonth(year, month, userId) {
        await this.ready;
        try {
            const monthStr = month.toString().padStart(2, '0');
            const yearMonth = `${year}-${monthStr}`;
            
            if (this.type === 'sqlite') {
                return new Promise((resolve, reject) => {
                    this.db.all(
                        "SELECT * FROM expenses WHERE date LIKE ? AND user_id = ? ORDER BY date DESC",
                        [`${yearMonth}%`, userId],
                        (err, rows) => {
                            if (err) reject(err); else resolve(rows || []);
                        }
                    );
                });
            } else if (this.type === 'mysql') {
                const [rows] = await this.db.execute(
                    "SELECT * FROM expenses WHERE date LIKE ? AND user_id = ? ORDER BY date DESC",
                    [`${yearMonth}%`, userId]
                );
                return rows || [];
            } else if (this.type === 'postgresql') {
                const result = await this.db.query(
                    "SELECT * FROM expenses WHERE date::text LIKE $1 AND user_id = $2 ORDER BY date DESC",
                    [`${yearMonth}%`, userId]
                );
                return result.rows || [];
            }
        } catch (error) {
            console.error('getExpensesByMonth error:', error.message);
            throw error;
        }
    }

    async getCategoryTotals(year, month, userId) {
        await this.ready;
        try {
            const monthStr = month.toString().padStart(2, '0');
            const yearMonth = `${year}-${monthStr}`;
            
            if (this.type === 'sqlite') {
                return new Promise((resolve, reject) => {
                    this.db.all(
                        `SELECT category, SUM(amount) as total
                         FROM expenses 
                         WHERE date LIKE ? AND user_id = ?
                         GROUP BY category 
                         ORDER BY total DESC`,
                        [`${yearMonth}%`, userId],
                        (err, rows) => {
                            if (err) reject(err); else resolve(rows || []);
                        }
                    );
                });
            } else if (this.type === 'mysql') {
                const [rows] = await this.db.execute(
                    `SELECT category, SUM(amount) as total
                     FROM expenses 
                     WHERE date LIKE ? AND user_id = ?
                     GROUP BY category 
                     ORDER BY total DESC`,
                    [`${yearMonth}%`, userId]
                );
                return rows || [];
            } else if (this.type === 'postgresql') {
                const result = await this.db.query(
                    `SELECT category, SUM(amount)::float as total
                     FROM expenses 
                     WHERE date::text LIKE $1 AND user_id = $2
                     GROUP BY category 
                     ORDER BY total DESC`,
                    [`${yearMonth}%`, userId]
                );
                return result.rows || [];
            }
        } catch (error) {
            console.error('getCategoryTotals error:', error.message);
            throw error;
        }
    }

    async getMonthlyTotals(userId) {
        await this.ready;
        try {
            if (this.type === 'sqlite') {
                return new Promise((resolve, reject) => {
                    this.db.all(
                        `SELECT 
                            substr(date, 1, 7) as month,
                            SUM(amount) as total
                         FROM expenses 
                         WHERE user_id = ?
                         GROUP BY substr(date, 1, 7)
                         ORDER BY month DESC
                         LIMIT 6`,
                        [userId],
                        (err, rows) => {
                            if (err) reject(err); else resolve(rows || []);
                        }
                    );
                });
            } else if (this.type === 'mysql') {
                const [rows] = await this.db.execute(
                    `SELECT 
                        DATE_FORMAT(date, '%Y-%m') as month,
                        SUM(amount) as total
                     FROM expenses 
                     WHERE user_id = ?
                     GROUP BY DATE_FORMAT(date, '%Y-%m')
                     ORDER BY month DESC
                     LIMIT 6`,
                    [userId]
                );
                return rows || [];
            } else if (this.type === 'postgresql') {
                const result = await this.db.query(
                    `SELECT 
                        TO_CHAR(date, 'YYYY-MM') as month,
                        SUM(amount)::float as total
                     FROM expenses 
                     WHERE user_id = $1
                     GROUP BY TO_CHAR(date, 'YYYY-MM')
                     ORDER BY month DESC
                     LIMIT 6`,
                    [userId]
                );
                return result.rows || [];
            }
        } catch (error) {
            console.error('getMonthlyTotals error:', error.message);
            throw error;
        }
    }

    async deleteExpense(id, userId) {
        await this.ready;
        try {
            if (this.type === 'sqlite') {
                return new Promise((resolve, reject) => {
                    this.db.run("DELETE FROM expenses WHERE id = ? AND user_id = ?", [id, userId], function(err) {
                        if (err) reject(err); else resolve({ deleted: this.changes > 0 });
                    });
                });
            } else if (this.type === 'mysql') {
                const [result] = await this.db.execute("DELETE FROM expenses WHERE id = ? AND user_id = ?", [id, userId]);
                return { deleted: result.affectedRows > 0 };
            } else if (this.type === 'postgresql') {
                const result = await this.db.query("DELETE FROM expenses WHERE id = $1 AND user_id = $2", [id, userId]);
                return { deleted: result.rowCount > 0 };
            }
        } catch (error) {
            console.error('deleteExpense error:', error.message);
            throw error;
        }
    }

    async runSQLite(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) reject(err); else resolve(this);
            });
        });
    }

    async close() {
        try {
            if (this.type === 'sqlite' && this.db) {
                this.db.close();
            } else if (this.type === 'mysql' && this.db) {
                await this.db.end();
            } else if (this.type === 'postgresql' && this.db) {
                await this.db.end();
            }
            console.log('Database connection closed');
        } catch (error) {
            console.error('Error closing database:', error.message);
        }
    }
}

// Create singleton instance
const dbManager = new DatabaseManager();

// Export database operations
const dbOperations = {
    createUser: (user) => dbManager.createUser(user),
    getUserByEmail: (email) => dbManager.getUserByEmail(email),
    updateUserBudget: (userId, budget) => dbManager.updateUserBudget(userId, budget),
    getUserBudget: (userId) => dbManager.getUserBudget(userId),
    addExpense: (expense) => dbManager.addExpense(expense),
    getAllExpenses: (userId) => dbManager.getAllExpenses(userId),
    getExpensesByMonth: (year, month, userId) => dbManager.getExpensesByMonth(year, month, userId),
    getCategoryTotals: (year, month, userId) => dbManager.getCategoryTotals(year, month, userId),
    getMonthlyTotals: (userId) => dbManager.getMonthlyTotals(userId),
    deleteExpense: (id, userId) => dbManager.deleteExpense(id, userId),
    ready: dbManager.ready
};

module.exports = { dbManager, dbOperations };
