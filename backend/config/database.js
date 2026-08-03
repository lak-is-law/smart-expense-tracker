const sqlite3 = require('sqlite3').verbose();
const mysql = require('mysql2/promise');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

// Database configuration
const DB_CONFIG = {
    type: process.env.DB_TYPE || 'sqlite', // sqlite, mysql, postgresql
    sqlite: {
        path: path.join(__dirname, '../../data/expenses.db')
    },
    mysql: {
        host: process.env.MYSQL_HOST || 'localhost',
        port: process.env.MYSQL_PORT || 3306,
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD || '',
        database: process.env.MYSQL_DATABASE || 'expense_tracker',
        connectionLimit: 10
    },
    postgresql: {
        host: process.env.PG_HOST || 'localhost',
        port: process.env.PG_PORT || 5432,
        user: process.env.PG_USER || 'postgres',
        password: process.env.PG_PASSWORD || '',
        database: process.env.PG_DATABASE || 'expense_tracker',
        max: 10
    }
};

// Use DATABASE_URL if available (for Vercel Postgres / Neon / Supabase / Render)
if (process.env.DATABASE_URL) {
    DB_CONFIG.type = 'postgresql';
    DB_CONFIG.postgresql = {
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    };
}

class DatabaseManager {
    constructor() {
        this.db = null;
        this.type = DB_CONFIG.type;
        this.initializeDatabase();
    }

    async initializeDatabase() {
        try {
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
        } catch (error) {
            console.error('❌ Database initialization failed:', error.message);
            if (this.type !== 'sqlite') {
                console.log('🔄 Falling back to SQLite...');
                this.type = 'sqlite';
                await this.initializeSQLite();
                await this.createTables();
            }
        }
    }

    async initializeSQLite() {
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(DB_CONFIG.sqlite.path, (err) => {
                if (err) {
                    reject(err);
                } else {
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
        this.db = new Pool(DB_CONFIG.postgresql);
        console.log('PostgreSQL connection pool created');
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
                // Ensure user_id column exists if table was created previously without it
                await this.runSQLite("ALTER TABLE expenses ADD COLUMN user_id TEXT", []).catch(() => {});
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

    // ---- User & Budget Operations ----
    async createUser(user) {
        try {
            if (this.type === 'sqlite') {
                return new Promise((resolve, reject) => {
                    const stmt = this.db.prepare(`INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)`);
                    stmt.run([user.userId, user.email, user.name, user.passwordHash || null], function(err) {
                        if (err) reject(err); else resolve(user);
                    });
                    stmt.finalize();
                });
            } else if (this.type === 'mysql') {
                await this.db.execute(
                    "INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)",
                    [user.userId, user.email, user.name, user.passwordHash || null]
                );
                return user;
            } else if (this.type === 'postgresql') {
                await this.db.query(
                    "INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)",
                    [user.userId, user.email, user.name, user.passwordHash || null]
                );
                return user;
            }
        } catch (error) {
            throw error;
        }
    }

    async getUserByEmail(email) {
        try {
            if (this.type === 'sqlite') {
                return new Promise((resolve, reject) => {
                    this.db.get("SELECT * FROM users WHERE email = ?", [email], (err, row) => {
                        if (err) reject(err); else resolve(row);
                    });
                });
            } else if (this.type === 'mysql') {
                const [rows] = await this.db.execute("SELECT * FROM users WHERE email = ?", [email]);
                return rows[0];
            } else if (this.type === 'postgresql') {
                const result = await this.db.query("SELECT * FROM users WHERE email = $1", [email]);
                return result.rows[0];
            }
        } catch (error) {
            throw error;
        }
    }

    async updateUserBudget(userId, budget) {
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
            throw error;
        }
    }

    async getUserBudget(userId) {
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
            console.error('Error getting user budget:', error.message);
            return 5000;
        }
    }

    // ---- Expense Operations ----
    async addExpense(expense) {
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
            throw error;
        }
    }

    async getAllExpenses(userId) {
        try {
            if (this.type === 'sqlite') {
                return new Promise((resolve, reject) => {
                    this.db.all("SELECT * FROM expenses WHERE user_id = ? ORDER BY date DESC", [userId], (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows || []);
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
            throw error;
        }
    }

    async getExpensesByMonth(year, month, userId) {
        try {
            const monthStr = month.toString().padStart(2, '0');
            const yearMonth = `${year}-${monthStr}`;
            
            if (this.type === 'sqlite') {
                return new Promise((resolve, reject) => {
                    this.db.all(
                        "SELECT * FROM expenses WHERE date LIKE ? AND user_id = ? ORDER BY date DESC",
                        [`${yearMonth}%`, userId],
                        (err, rows) => {
                            if (err) reject(err);
                            else resolve(rows || []);
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
            throw error;
        }
    }

    async getCategoryTotals(year, month, userId) {
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
                            if (err) reject(err);
                            else resolve(rows || []);
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
                    `SELECT category, SUM(amount) as total
                     FROM expenses 
                     WHERE date::text LIKE $1 AND user_id = $2
                     GROUP BY category 
                     ORDER BY total DESC`,
                    [`${yearMonth}%`, userId]
                );
                return result.rows || [];
            }
        } catch (error) {
            throw error;
        }
    }

    async getMonthlyTotals(userId) {
        try {
            if (this.type === 'sqlite') {
                return new Promise((resolve, reject) => {
                    this.db.all(
                        `SELECT 
                            strftime('%Y-%m', date) as month,
                            SUM(amount) as total
                         FROM expenses 
                         WHERE user_id = ?
                         GROUP BY strftime('%Y-%m', date)
                         ORDER BY month DESC
                         LIMIT 6`,
                        [userId],
                        (err, rows) => {
                            if (err) reject(err);
                            else resolve(rows || []);
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
                        SUM(amount) as total
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
            throw error;
        }
    }

    async deleteExpense(id, userId) {
        try {
            if (this.type === 'sqlite') {
                return new Promise((resolve, reject) => {
                    this.db.run("DELETE FROM expenses WHERE id = ? AND user_id = ?", [id, userId], function(err) {
                        if (err) reject(err);
                        else resolve({ deleted: this.changes > 0 });
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
            throw error;
        }
    }

    async runSQLite(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve(this);
            });
        });
    }

    async close() {
        try {
            if (this.type === 'sqlite') {
                this.db.close();
            } else if (this.type === 'mysql') {
                await this.db.end();
            } else if (this.type === 'postgresql') {
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
    deleteExpense: (id, userId) => dbManager.deleteExpense(id, userId)
};

module.exports = { dbManager, dbOperations };
