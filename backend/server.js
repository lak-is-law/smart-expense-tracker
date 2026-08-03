const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { dbOperations } = require('./config/database');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const emailValidator = require('email-validator');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json());

// Normalize /api prefix for Vercel serverless deployment
app.use((req, res, next) => {
    if (req.url.startsWith('/api/')) {
        req.url = req.url.slice(4);
    } else if (req.url === '/api') {
        req.url = '/';
    }
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path} (Original: ${req.originalUrl || req.url})`);
    next();
});

// Auth helpers
async function verifyGoogleIdToken(idToken) {
    try {
        const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`;
        const { data } = await axios.get(url);
        if (!data || !data.sub) throw new Error('Invalid Google token');
        return { userId: data.sub, email: data.email, name: data.name, picture: data.picture };
    } catch (err) {
        const detail = err?.response?.data?.error_description || err?.response?.data || err.message;
        const e = new Error(`Google token verification failed: ${detail}`);
        e.status = 401;
        throw e;
    }
}

function createJwt(user) {
    return jwt.sign({ userId: user.id || user.userId, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

function authenticate(req, res, next) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.user = payload;
        next();
    } catch (_) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

// Simple AI prediction function
function predictNextMonth(monthlyTotals) {
    if (monthlyTotals.length < 2) return 0;
    
    const recent = monthlyTotals[0].total;
    const previous = monthlyTotals[1].total;
    const trend = recent - previous;
    return Math.max(0, recent + trend);
}

// Generate AI insights
function generateInsights(expenses, categoryTotals, monthlyTotals) {
    const insights = {
        predictions: { nextMonth: predictNextMonth(monthlyTotals) },
        recommendations: [],
        anomalies: []
    };

    if (categoryTotals.length > 0) {
        const total = categoryTotals.reduce((sum, cat) => sum + cat.total, 0);
        const highest = categoryTotals[0];
        const percentage = (highest.total / total) * 100;
        
        if (percentage > 50) {
            insights.recommendations.push(
                `Consider reducing ${highest.category} spending (${percentage.toFixed(1)}% of total)`
            );
        }
    }

    if (expenses.length > 0) {
        const amounts = expenses.map(exp => exp.amount);
        const avg = amounts.reduce((sum, amt) => sum + amt, 0) / amounts.length;
        const threshold = avg * 2;
        
        const anomalies = expenses.filter(exp => exp.amount > threshold);
        insights.anomalies = anomalies.map(exp => ({
            date: exp.date,
            amount: exp.amount,
            description: exp.description
        }));
    }

    return insights;
}

// Auth routes
app.post('/auth/signup', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        
        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Name, email, and password are required' });
        }

        if (!emailValidator.validate(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters long' });
        }

        const existingUser = await dbOperations.getUserByEmail(email);
        if (existingUser) {
            return res.status(409).json({ error: 'User with this email already exists' });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const userId = 'usr_' + Date.now() + Math.floor(Math.random() * 1000);
        
        const user = await dbOperations.createUser({
            userId,
            email,
            name,
            passwordHash
        });

        const token = createJwt(user);
        res.status(201).json({ token, user: { userId: user.userId, email: user.email, name: user.name }, message: 'Account created successfully' });
    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({ error: error.message || 'Signup failed' });
    }
});

app.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required', code: 'MISSING_FIELDS' });
        }

        const trimmedEmail = email.trim().toLowerCase();
        const user = await dbOperations.getUserByEmail(trimmedEmail);
        
        if (!user) {
            return res.status(404).json({ 
                error: 'No account found with this email address. Please check your spelling or create a new account.', 
                code: 'USER_NOT_FOUND',
                email: trimmedEmail
            });
        }

        if (!user.password_hash) {
            return res.status(400).json({ 
                error: 'This email is linked to Google Sign-In. Please click "Sign in with Google" below.', 
                code: 'GOOGLE_AUTH_REQUIRED' 
            });
        }

        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ 
                error: 'Incorrect password. Please double-check your password and try again.', 
                code: 'INVALID_PASSWORD' 
            });
        }

        const token = createJwt(user);
        res.json({ token, user: { userId: user.id, email: user.email, name: user.name } });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: error.message || 'Login failed. Please try again.' });
    }
});

app.post('/auth/google', async (req, res) => {
    try {
        const { idToken } = req.body;
        if (!idToken) return res.status(400).json({ error: 'Missing idToken' });
        
        const googleUser = await verifyGoogleIdToken(idToken);
        let user = await dbOperations.getUserByEmail(googleUser.email);
        
        if (!user) {
            const userId = 'usr_' + Date.now() + Math.floor(Math.random() * 1000);
            await dbOperations.createUser({
                userId,
                email: googleUser.email,
                name: googleUser.name,
                passwordHash: null
            });
            user = await dbOperations.getUserByEmail(googleUser.email);
        }

        const token = createJwt(user);
        res.json({ token, user: { userId: user.id, email: user.email, name: user.name } });
    } catch (error) {
        const status = error.status || 401;
        res.status(status).json({ error: error.message || 'Google authentication failed' });
    }
});

// API Routes
app.post('/add-expense', authenticate, async (req, res) => {
    try {
        const { date, category, amount, description } = req.body;
        
        if (!date || !category || !amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid data: date, category, and valid amount required' });
        }

        const expense = await dbOperations.addExpense({
            date, category, amount: parseFloat(amount), description: description || '', user_id: req.user.userId
        });

        res.status(201).json({ message: 'Expense added', expense });
    } catch (error) {
        console.error('Error adding expense:', error);
        res.status(500).json({ error: 'Failed to add expense: ' + error.message });
    }
});

app.get('/expenses', authenticate, async (req, res) => {
    try {
        const expenses = await dbOperations.getAllExpenses(req.user.userId);
        res.json(expenses);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch expenses' });
    }
});

app.delete('/expenses/:id', authenticate, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
        const result = await dbOperations.deleteExpense(id, req.user.userId);
        if (!result.deleted) return res.status(404).json({ error: 'Expense not found' });
        res.json({ message: 'Expense deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete expense' });
    }
});

app.get('/report', authenticate, async (req, res) => {
    try {
        const currentYear = new Date().getFullYear();
        const currentMonth = new Date().getMonth() + 1;

        const [expenses, categoryTotals, monthlyTotals] = await Promise.all([
            dbOperations.getExpensesByMonth(currentYear, currentMonth, req.user.userId),
            dbOperations.getCategoryTotals(currentYear, currentMonth, req.user.userId),
            dbOperations.getMonthlyTotals(req.user.userId)
        ]);

        const totalSpending = expenses.reduce((sum, exp) => sum + exp.amount, 0);
        const monthlyBudget = await dbOperations.getUserBudget(req.user.userId);
        const isOverBudget = totalSpending > monthlyBudget;

        res.json({
            expenses,
            categoryTotals,
            monthlyTotals,
            totalSpending: Math.round(totalSpending * 100) / 100,
            isOverBudget,
            budgetLimit: monthlyBudget
        });
    } catch (error) {
        console.error('Report error:', error);
        res.status(500).json({ error: 'Failed to generate report' });
    }
});

app.get('/ai-insights', authenticate, async (req, res) => {
    try {
        const { range, category } = req.query; 
        
        let expenses = await dbOperations.getAllExpenses(req.user.userId);
        
        if (range && range !== 'all') {
            const now = new Date();
            let startDate;
            if (range === '30') {
                startDate = new Date(now);
                startDate.setDate(startDate.getDate() - 30);
            } else if (range === '90') {
                startDate = new Date(now);
                startDate.setDate(startDate.getDate() - 90);
            } else if (range === 'ytd') {
                startDate = new Date(now.getFullYear(), 0, 1);
            }
            if (startDate) {
                expenses = expenses.filter(exp => new Date(exp.date) >= startDate);
            }
        }
        
        if (category && category !== 'all') {
            expenses = expenses.filter(exp => exp.category === category);
        }

        const categoryTotalsMap = {};
        expenses.forEach(exp => {
            categoryTotalsMap[exp.category] = (categoryTotalsMap[exp.category] || 0) + exp.amount;
        });
        const categoryTotals = Object.entries(categoryTotalsMap)
            .map(([category, total]) => ({ category, total }))
            .sort((a, b) => b.total - a.total);

        const monthlyTotalsMap = {};
        expenses.forEach(exp => {
            const date = new Date(exp.date);
            const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
            monthlyTotalsMap[monthKey] = (monthlyTotalsMap[monthKey] || 0) + exp.amount;
        });
        const monthlyTotals = Object.entries(monthlyTotalsMap)
            .map(([month, total]) => ({ month, total }))
            .sort((a, b) => a.month.localeCompare(b.month))
            .slice(-6); 

        const insights = generateInsights(expenses, categoryTotals, monthlyTotals);
        
        insights.trendData = monthlyTotals.map(m => ({
            label: m.month,
            total: m.total
        }));

        res.json({ insights });
    } catch (error) {
        console.error('Error generating insights:', error);
        res.status(500).json({ error: 'Failed to generate insights' });
    }
});

app.get('/budget', authenticate, async (req, res) => {
    try {
        const budget = await dbOperations.getUserBudget(req.user.userId);
        res.json({ budget });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get budget' });
    }
});

app.put('/budget', authenticate, async (req, res) => {
    try {
        const { budget } = req.body;
        if (!budget || budget < 0 || isNaN(budget)) {
            return res.status(400).json({ error: 'Valid budget amount required' });
        }
        await dbOperations.updateUserBudget(req.user.userId, parseFloat(budget));
        res.json({ budget: parseFloat(budget), message: 'Budget updated successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update budget' });
    }
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        message: 'TO DAR 2.O API running',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });
}

module.exports = app;
