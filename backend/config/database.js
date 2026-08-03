const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Safely attempt to require database drivers without crashing on serverless runtimes
let sqlite3 = null;
try {
    sqlite3 = require('sqlite3').verbose();
} catch (e) {
    console.warn('ℹ️ Native sqlite3 not available in this runtime, using JSON storage engine:', e.message);
}

let mysql = null;
try {
    mysql = require('mysql2/promise');
} catch (e) {
    console.warn('ℹ️ mysql2 not loaded:', e.message);
}

let pg = null;
try {
    pg = require('pg');
} catch (e) {
    console.warn('ℹ️ pg not loaded:', e.message);
}

// Determine serverless/read-only environment
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);

// File paths
const defaultSqlitePath = isServerless 
    ? path.join('/tmp', 'expenses.db') 
    : path.join(__dirname, '../../data/expenses.db');

const jsonDbPath = isServerless 
    ? path.join('/tmp', 'todar_data.json') 
    : path.join(__dirname, '../../data/todar_data.json');

// Ensure directories exist
[path.dirname(defaultSqlitePath), path.dirname(jsonDbPath)].forEach(dir => {
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}
});

// Database configuration
const hasPostgres = Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL);
let selectedType = 'sqlite';

if (hasPostgres && pg) {
    selectedType = 'postgresql';
} else if (process.env.DB_TYPE === 'mysql' && mysql) {
    selectedType = 'mysql';
} else if (sqlite3) {
    selectedType = 'sqlite';
} else {
    selectedType = 'json'; // 100% crash-proof fallback for Vercel without native binaries
}

const DB_CONFIG = {
    type: selectedType,
    sqlite: {
        path: process.env.SQLITE_PATH || defaultSqlitePath
    },
    mysql: {
        host: process.env.MYSQL_HOST || 'localhost',
        port: parseInt(process.env.MYSQL_PORT, 10) || 3306,
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD || '',
        database: process.env.MYSQL_DATABASE || 'expense_tracker'
    },
    postgresql: {
        connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL,
        ssl: { rejectUnauthorized: false }
    }
};

class DatabaseManager {
    constructor() {
        this.db = null;
        this.type = DB_CONFIG.type;
        this.jsonData = { users: [], expenses: [] };
        this.ready = this.initializeDatabase();
    }

    async initializeDatabase() {
        try {
            console.log(`🔌 Initializing database [Type: ${this.type.toUpperCase()}]...`);
            
            if (this.type === 'postgresql' && pg) {
                await this.initializePostgreSQL();
            } else if (this.type === 'mysql' && mysql) {
                await this.initializeMySQL();
            } else if (this.type === 'sqlite' && sqlite3) {
                await this.initializeSQLite();
            } else {
                this.type = 'json';
                await this.initializeJSON();
            }

            console.log(`✅ Database ready [Type: ${this.type.toUpperCase()}]`);
            if (this.type !== 'json') {
                await this.createTables();
            }
        } catch (error) {
            console.error('❌ Database initialization error:', error.message);
            console.log('🔄 Activating pure JSON storage engine fallback...');
            this.type = 'json';
            await this.initializeJSON();
        }
    }

    async initializeJSON() {
        try {
            if (fs.existsSync(jsonDbPath)) {
                const raw = fs.readFileSync(jsonDbPath, 'utf8');
                this.jsonData = JSON.parse(raw);
            } else {
                this.jsonData = { users: [], expenses: [] };
                this.saveJSON();
            }
        } catch (_) {
            this.jsonData = { users: [], expenses: [] };
        }
    }

    saveJSON() {
        try {
            fs.writeFileSync(jsonDbPath, JSON.stringify(this.jsonData, null, 2), 'utf8');
        } catch (e) {
            console.warn('Could not persist JSON to disk:', e.message);
        }
    }

    async initializeSQLite() {
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(DB_CONFIG.sqlite.path, (err) => {
                if (err) reject(err); else resolve();
            });
        });
    }

    async initializeMySQL() {
        this.db = await mysql.createConnection(DB_CONFIG.mysql);
    }

    async initializePostgreSQL() {
        this.db = new pg.Pool({
            connectionString: DB_CONFIG.postgresql.connectionString,
            ssl: DB_CONFIG.postgresql.ssl
        });
        const client = await this.db.connect();
        client.release();
    }

    async createTables() {
        if (this.type === 'json') return;

        const createUsersSQL = `
            CREATE TABLE IF NOT EXISTS users (
                id ${this.type === 'postgresql' || this.type === 'mysql' ? 'VARCHAR(255) PRIMARY KEY' : 'TEXT PRIMARY KEY'},
                email ${this.type === 'postgresql' || this.type === 'mysql' ? 'VARCHAR(255) UNIQUE NOT NULL' : 'TEXT UNIQUE NOT NULL'},
                name ${this.type === 'postgresql' || this.type === 'mysql' ? 'VARCHAR(255) NOT NULL' : 'TEXT NOT NULL'},
                password_hash TEXT,
                monthly_budget ${this.type === 'postgresql' ? 'DECIMAL(10,2) DEFAULT 5000' : this.type === 'mysql' ? 'DECIMAL(10,2) DEFAULT 5000' : 'REAL DEFAULT 5000'},
                created_at ${this.type === 'postgresql' || this.type === 'mysql' ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP'}
            )
        `;

        const createExpensesSQL = `
            CREATE TABLE IF NOT EXISTS expenses (
                id ${this.type === 'postgresql' ? 'SERIAL PRIMARY KEY' : this.type === 'mysql' ? 'INT AUTO_INCREMENT PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
                user_id ${this.type === 'postgresql' || this.type === 'mysql' ? 'VARCHAR(255)' : 'TEXT'} NOT NULL,
                date ${this.type === 'postgresql' ? 'DATE' : 'TEXT'} NOT NULL,
                category ${this.type === 'postgresql' ? 'VARCHAR(100)' : 'TEXT'} NOT NULL,
                amount ${this.type === 'postgresql' ? 'DECIMAL(10,2)' : 'REAL'} NOT NULL,
                description TEXT,
                created_at ${this.type === 'postgresql' || this.type === 'mysql' ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP'}
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
        } catch (error) {
            console.error('Error creating SQL tables:', error.message);
        }
    }

    // ---- User Operations ----
    async createUser(user) {
        await this.ready;
        const userId = user.userId || user.id;
        const passwordHash = user.passwordHash || user.password_hash || null;
        const email = (user.email || '').trim().toLowerCase();
        const name = (user.name || '').trim();

        if (this.type === 'json') {
            const newUser = {
                id: userId,
                userId,
                email,
                name,
                password_hash: passwordHash,
                monthly_budget: 5000,
                created_at: new Date().toISOString()
            };
            this.jsonData.users.push(newUser);
            this.saveJSON();
            return { id: userId, userId, email, name };
        }

        if (this.type === 'sqlite') {
            return new Promise((resolve, reject) => {
                const stmt = this.db.prepare(`INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)`);
                stmt.run([userId, email, name, passwordHash], function(err) {
                    if (err) return reject(err);
                    resolve({ id: userId, userId, email, name });
                });
                stmt.finalize();
            });
        }

        if (this.type === 'mysql') {
            await this.db.execute(
                "INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)",
                [userId, email, name, passwordHash]
            );
            return { id: userId, userId, email, name };
        }

        if (this.type === 'postgresql') {
            await this.db.query(
                "INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)",
                [userId, email, name, passwordHash]
            );
            return { id: userId, userId, email, name };
        }
    }

    async getUserByEmail(email) {
        await this.ready;
        const normalized = (email || '').trim().toLowerCase();

        if (this.type === 'json') {
            const user = this.jsonData.users.find(u => u.email.toLowerCase() === normalized);
            return user ? { ...user } : null;
        }

        if (this.type === 'sqlite') {
            return new Promise((resolve, reject) => {
                this.db.get("SELECT * FROM users WHERE LOWER(email) = LOWER(?)", [normalized], (err, row) => {
                    if (err) reject(err); else resolve(row || null);
                });
            });
        }

        if (this.type === 'mysql') {
            const [rows] = await this.db.execute("SELECT * FROM users WHERE LOWER(email) = LOWER(?)", [normalized]);
            return rows[0] || null;
        }

        if (this.type === 'postgresql') {
            const result = await this.db.query("SELECT * FROM users WHERE LOWER(email) = LOWER($1)", [normalized]);
            return result.rows[0] || null;
        }
    }

    async updateUserBudget(userId, budget) {
        await this.ready;
        if (this.type === 'json') {
            const user = this.jsonData.users.find(u => u.id === userId || u.userId === userId);
            if (user) user.monthly_budget = parseFloat(budget);
            this.saveJSON();
            return;
        }

        if (this.type === 'sqlite') {
            return new Promise((resolve, reject) => {
                const stmt = this.db.prepare("UPDATE users SET monthly_budget = ? WHERE id = ?");
                stmt.run([budget, userId], (err) => { if (err) reject(err); else resolve(); });
                stmt.finalize();
            });
        }

        if (this.type === 'mysql') {
            await this.db.execute("UPDATE users SET monthly_budget = ? WHERE id = ?", [budget, userId]);
        }

        if (this.type === 'postgresql') {
            await this.db.query("UPDATE users SET monthly_budget = $1 WHERE id = $2", [budget, userId]);
        }
    }

    async getUserBudget(userId) {
        await this.ready;
        if (this.type === 'json') {
            const user = this.jsonData.users.find(u => u.id === userId || u.userId === userId);
            return user && user.monthly_budget ? parseFloat(user.monthly_budget) : 5000;
        }

        if (this.type === 'sqlite') {
            return new Promise((resolve, reject) => {
                this.db.get("SELECT monthly_budget FROM users WHERE id = ?", [userId], (err, row) => {
                    if (err) reject(err); else resolve(row ? row.monthly_budget : 5000);
                });
            });
        }

        if (this.type === 'mysql') {
            const [rows] = await this.db.execute("SELECT monthly_budget FROM users WHERE id = ?", [userId]);
            return rows[0] ? parseFloat(rows[0].monthly_budget) : 5000;
        }

        if (this.type === 'postgresql') {
            const result = await this.db.query("SELECT monthly_budget FROM users WHERE id = $1", [userId]);
            return result.rows[0] ? parseFloat(result.rows[0].monthly_budget) : 5000;
        }
        return 5000;
    }

    // ---- Expense Operations ----
    async addExpense(expense) {
        await this.ready;
        const amount = parseFloat(expense.amount);

        if (this.type === 'json') {
            const newExp = {
                id: Date.now() + Math.floor(Math.random() * 1000),
                user_id: expense.user_id,
                date: expense.date,
                category: expense.category,
                amount,
                description: expense.description || '',
                created_at: new Date().toISOString()
            };
            this.jsonData.expenses.push(newExp);
            this.saveJSON();
            return newExp;
        }

        if (this.type === 'sqlite') {
            return new Promise((resolve, reject) => {
                const stmt = this.db.prepare(`INSERT INTO expenses (date, category, amount, description, user_id) VALUES (?, ?, ?, ?, ?)`);
                stmt.run([expense.date, expense.category, amount, expense.description, expense.user_id], function(err) {
                    if (err) reject(err); else resolve({ id: this.lastID, ...expense, amount });
                });
                stmt.finalize();
            });
        }

        if (this.type === 'mysql') {
            const [result] = await this.db.execute(
                "INSERT INTO expenses (date, category, amount, description, user_id) VALUES (?, ?, ?, ?, ?)",
                [expense.date, expense.category, amount, expense.description, expense.user_id]
            );
            return { id: result.insertId, ...expense, amount };
        }

        if (this.type === 'postgresql') {
            const result = await this.db.query(
                "INSERT INTO expenses (date, category, amount, description, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id",
                [expense.date, expense.category, amount, expense.description, expense.user_id]
            );
            return { id: result.rows[0].id, ...expense, amount };
        }
    }

    async getAllExpenses(userId) {
        await this.ready;
        if (this.type === 'json') {
            return this.jsonData.expenses
                .filter(e => e.user_id === userId)
                .sort((a, b) => new Date(b.date) - new Date(a.date));
        }

        if (this.type === 'sqlite') {
            return new Promise((resolve, reject) => {
                this.db.all("SELECT * FROM expenses WHERE user_id = ? ORDER BY date DESC", [userId], (err, rows) => {
                    if (err) reject(err); else resolve(rows || []);
                });
            });
        }

        if (this.type === 'mysql') {
            const [rows] = await this.db.execute("SELECT * FROM expenses WHERE user_id = ? ORDER BY date DESC", [userId]);
            return rows || [];
        }

        if (this.type === 'postgresql') {
            const result = await this.db.query("SELECT * FROM expenses WHERE user_id = $1 ORDER BY date DESC", [userId]);
            return result.rows || [];
        }
        return [];
    }

    async getExpensesByMonth(year, month, userId) {
        await this.ready;
        const monthStr = month.toString().padStart(2, '0');
        const yearMonth = `${year}-${monthStr}`;

        if (this.type === 'json') {
            return this.jsonData.expenses
                .filter(e => e.user_id === userId && e.date.startsWith(yearMonth))
                .sort((a, b) => new Date(b.date) - new Date(a.date));
        }

        if (this.type === 'sqlite') {
            return new Promise((resolve, reject) => {
                this.db.all("SELECT * FROM expenses WHERE date LIKE ? AND user_id = ? ORDER BY date DESC", [`${yearMonth}%`, userId], (err, rows) => {
                    if (err) reject(err); else resolve(rows || []);
                });
            });
        }

        if (this.type === 'mysql') {
            const [rows] = await this.db.execute("SELECT * FROM expenses WHERE date LIKE ? AND user_id = ? ORDER BY date DESC", [`${yearMonth}%`, userId]);
            return rows || [];
        }

        if (this.type === 'postgresql') {
            const result = await this.db.query("SELECT * FROM expenses WHERE date::text LIKE $1 AND user_id = $2 ORDER BY date DESC", [`${yearMonth}%`, userId]);
            return result.rows || [];
        }
        return [];
    }

    async getCategoryTotals(year, month, userId) {
        await this.ready;
        const monthStr = month.toString().padStart(2, '0');
        const yearMonth = `${year}-${monthStr}`;

        if (this.type === 'json') {
            const map = {};
            this.jsonData.expenses
                .filter(e => e.user_id === userId && e.date.startsWith(yearMonth))
                .forEach(e => {
                    map[e.category] = (map[e.category] || 0) + (parseFloat(e.amount) || 0);
                });
            return Object.entries(map)
                .map(([category, total]) => ({ category, total }))
                .sort((a, b) => b.total - a.total);
        }

        if (this.type === 'sqlite') {
            return new Promise((resolve, reject) => {
                this.db.all(
                    "SELECT category, SUM(amount) as total FROM expenses WHERE date LIKE ? AND user_id = ? GROUP BY category ORDER BY total DESC",
                    [`${yearMonth}%`, userId],
                    (err, rows) => { if (err) reject(err); else resolve(rows || []); }
                );
            });
        }

        if (this.type === 'mysql') {
            const [rows] = await this.db.execute(
                "SELECT category, SUM(amount) as total FROM expenses WHERE date LIKE ? AND user_id = ? GROUP BY category ORDER BY total DESC",
                [`${yearMonth}%`, userId]
            );
            return rows || [];
        }

        if (this.type === 'postgresql') {
            const result = await this.db.query(
                "SELECT category, SUM(amount)::float as total FROM expenses WHERE date::text LIKE $1 AND user_id = $2 GROUP BY category ORDER BY total DESC",
                [`${yearMonth}%`, userId]
            );
            return result.rows || [];
        }
        return [];
    }

    async getMonthlyTotals(userId) {
        await this.ready;
        if (this.type === 'json') {
            const map = {};
            this.jsonData.expenses
                .filter(e => e.user_id === userId)
                .forEach(e => {
                    const ym = (e.date || '').slice(0, 7);
                    if (ym) map[ym] = (map[ym] || 0) + (parseFloat(e.amount) || 0);
                });
            return Object.entries(map)
                .map(([month, total]) => ({ month, total }))
                .sort((a, b) => b.month.localeCompare(a.month))
                .slice(0, 6);
        }

        if (this.type === 'sqlite') {
            return new Promise((resolve, reject) => {
                this.db.all(
                    "SELECT substr(date, 1, 7) as month, SUM(amount) as total FROM expenses WHERE user_id = ? GROUP BY substr(date, 1, 7) ORDER BY month DESC LIMIT 6",
                    [userId],
                    (err, rows) => { if (err) reject(err); else resolve(rows || []); }
                );
            });
        }

        if (this.type === 'mysql') {
            const [rows] = await this.db.execute(
                "SELECT DATE_FORMAT(date, '%Y-%m') as month, SUM(amount) as total FROM expenses WHERE user_id = ? GROUP BY DATE_FORMAT(date, '%Y-%m') ORDER BY month DESC LIMIT 6",
                [userId]
            );
            return rows || [];
        }

        if (this.type === 'postgresql') {
            const result = await this.db.query(
                "SELECT TO_CHAR(date, 'YYYY-MM') as month, SUM(amount)::float as total FROM expenses WHERE user_id = $1 GROUP BY TO_CHAR(date, 'YYYY-MM') ORDER BY month DESC LIMIT 6",
                [userId]
            );
            return result.rows || [];
        }
        return [];
    }

    async deleteExpense(id, userId) {
        await this.ready;
        if (this.type === 'json') {
            const initialLen = this.jsonData.expenses.length;
            this.jsonData.expenses = this.jsonData.expenses.filter(e => !(String(e.id) === String(id) && e.user_id === userId));
            this.saveJSON();
            return { deleted: this.jsonData.expenses.length < initialLen };
        }

        if (this.type === 'sqlite') {
            return new Promise((resolve, reject) => {
                this.db.run("DELETE FROM expenses WHERE id = ? AND user_id = ?", [id, userId], function(err) {
                    if (err) reject(err); else resolve({ deleted: this.changes > 0 });
                });
            });
        }

        if (this.type === 'mysql') {
            const [result] = await this.db.execute("DELETE FROM expenses WHERE id = ? AND user_id = ?", [id, userId]);
            return { deleted: result.affectedRows > 0 };
        }

        if (this.type === 'postgresql') {
            const result = await this.db.query("DELETE FROM expenses WHERE id = $1 AND user_id = $2", [id, userId]);
            return { deleted: result.rowCount > 0 };
        }
        return { deleted: false };
    }

    async runSQLite(sql, params = []) {
        if (!this.db || !sqlite3) return;
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) reject(err); else resolve(this);
            });
        });
    }
}

// Singleton instance
const dbManager = new DatabaseManager();

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
