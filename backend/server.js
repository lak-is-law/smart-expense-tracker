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

// CORS setup
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body parser
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// Request Logger
app.use((req, res, next) => {
    const start = Date.now();
    const cleanBody = req.body ? { ...req.body } : {};
    if (cleanBody.password) cleanBody.password = '[REDACTED]';
    if (cleanBody.idToken) cleanBody.idToken = '[ID_TOKEN_TRUNCATED]';

    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`[API] ${req.method} ${req.originalUrl || req.url} -> Status: ${res.statusCode} (${duration}ms)`);
    });

    next();
});

// Auth helpers
async function verifyGoogleIdToken(idToken) {
    try {
        const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`;
        const { data } = await axios.get(url);
        if (!data || !data.sub) throw new Error('Invalid Google token payload');
        return { userId: data.sub, email: data.email, name: data.name, picture: data.picture };
    } catch (err) {
        const detail = err?.response?.data?.error_description || err?.response?.data || err.message;
        const e = new Error(`Google token verification failed: ${detail}`);
        e.status = 401;
        throw e;
    }
}

function createJwt(user) {
    const userId = user.id || user.userId;
    return jwt.sign({ userId, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

function authenticate(req, res, next) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) {
        return res.status(401).json({ success: false, error: 'Unauthorized: missing authentication token', code: 'UNAUTHORIZED' });
    }
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.user = payload;
        next();
    } catch (_) {
        return res.status(401).json({ success: false, error: 'Invalid or expired token', code: 'INVALID_TOKEN' });
    }
}

// AI prediction function
function predictNextMonth(monthlyTotals) {
    if (!monthlyTotals || monthlyTotals.length < 2) return 0;
    const recent = monthlyTotals[0]?.total || 0;
    const previous = monthlyTotals[1]?.total || 0;
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

    if (categoryTotals && categoryTotals.length > 0) {
        const total = categoryTotals.reduce((sum, cat) => sum + (parseFloat(cat.total) || 0), 0);
        const highest = categoryTotals[0];
        if (total > 0 && highest) {
            const percentage = (parseFloat(highest.total) / total) * 100;
            if (percentage > 50) {
                insights.recommendations.push(
                    `Consider reducing ${highest.category} spending (${percentage.toFixed(1)}% of total)`
                );
            }
        }
    }

    if (expenses && expenses.length > 0) {
        const amounts = expenses.map(exp => parseFloat(exp.amount) || 0);
        const avg = amounts.reduce((sum, amt) => sum + amt, 0) / amounts.length;
        const threshold = avg * 2;
        
        const anomalies = expenses.filter(exp => (parseFloat(exp.amount) || 0) > threshold);
        insights.anomalies = anomalies.map(exp => ({
            date: exp.date,
            amount: exp.amount,
            description: exp.description
        }));
    }

    return insights;
}

// ==========================================
// API Router (Mounted on both /api and /)
// ==========================================
const apiRouter = express.Router();

// Health check
apiRouter.get('/health', (req, res) => {
    res.json({ 
        success: true,
        status: 'OK', 
        message: 'Todar API is active',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Auth Routes
apiRouter.post('/auth/signup', async (req, res) => {
    try {
        const { name, email, password } = req.body || {};
        
        if (!name || !name.trim() || !email || !email.trim() || !password) {
            return res.status(400).json({ 
                success: false, 
                error: 'Full name, email address, and password are all required.',
                code: 'MISSING_FIELDS' 
            });
        }

        const trimmedEmail = email.trim().toLowerCase();
        const trimmedName = name.trim();

        if (!emailValidator.validate(trimmedEmail)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Please enter a valid email address format.',
                code: 'INVALID_EMAIL' 
            });
        }

        if (password.length < 6) {
            return res.status(400).json({ 
                success: false, 
                error: 'Password must be at least 6 characters long.',
                code: 'PASSWORD_TOO_SHORT' 
            });
        }

        const existingUser = await dbOperations.getUserByEmail(trimmedEmail);
        if (existingUser) {
            return res.status(409).json({ 
                success: false, 
                error: `An account with email ${trimmedEmail} is already registered.`,
                code: 'USER_EXISTS' 
            });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const userId = 'usr_' + Date.now() + Math.floor(Math.random() * 1000);
        
        const created = await dbOperations.createUser({
            userId,
            email: trimmedEmail,
            name: trimmedName,
            passwordHash
        });

        const token = createJwt(created);
        return res.status(201).json({
            success: true,
            token,
            user: {
                userId: created.userId || created.id,
                email: created.email,
                name: created.name
            },
            message: 'Account created successfully'
        });
    } catch (error) {
        console.error('Signup error:', error);
        return res.status(500).json({ 
            success: false, 
            error: error.message || 'An unexpected error occurred during signup.',
            code: 'SIGNUP_FAILED' 
        });
    }
});

apiRouter.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body || {};
        if (!email || !email.trim() || !password) {
            return res.status(400).json({ 
                success: false, 
                error: 'Both email address and password are required.',
                code: 'MISSING_FIELDS' 
            });
        }

        const trimmedEmail = email.trim().toLowerCase();
        const user = await dbOperations.getUserByEmail(trimmedEmail);
        
        if (!user) {
            return res.status(404).json({ 
                success: false,
                error: `No account found with ${trimmedEmail}. Please check spelling or create an account.`, 
                code: 'USER_NOT_FOUND',
                email: trimmedEmail
            });
        }

        if (!user.password_hash) {
            return res.status(400).json({ 
                success: false,
                error: 'This account is linked with Google Sign-In. Please use the Google button below.', 
                code: 'GOOGLE_AUTH_REQUIRED' 
            });
        }

        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ 
                success: false,
                error: 'Incorrect password. Please double-check your credentials and try again.', 
                code: 'INVALID_PASSWORD' 
            });
        }

        const token = createJwt(user);
        return res.json({
            success: true,
            token,
            user: {
                userId: user.id || user.userId,
                email: user.email,
                name: user.name
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({ 
            success: false, 
            error: error.message || 'Login failed. Please try again.',
            code: 'LOGIN_FAILED' 
        });
    }
});

apiRouter.post('/auth/google', async (req, res) => {
    try {
        const { idToken } = req.body || {};
        if (!idToken) {
            return res.status(400).json({ success: false, error: 'Missing Google ID token', code: 'MISSING_TOKEN' });
        }
        
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
        return res.json({
            success: true,
            token,
            user: {
                userId: user.id || user.userId,
                email: user.email,
                name: user.name
            }
        });
    } catch (error) {
        console.error('Google auth error:', error);
        const status = error.status || 401;
        return res.status(status).json({ 
            success: false, 
            error: error.message || 'Google authentication failed.',
            code: 'GOOGLE_AUTH_FAILED' 
        });
    }
});

// Expense Routes
apiRouter.post('/add-expense', authenticate, async (req, res) => {
    try {
        const { date, category, amount, description } = req.body || {};
        
        if (!date || !category || !amount || parseFloat(amount) <= 0) {
            return res.status(400).json({ success: false, error: 'Valid date, category, and positive amount are required.' });
        }

        const expense = await dbOperations.addExpense({
            date,
            category,
            amount: parseFloat(amount),
            description: description || '',
            user_id: req.user.userId
        });

        return res.status(201).json({ success: true, message: 'Expense added successfully', expense });
    } catch (error) {
        console.error('Add expense error:', error);
        return res.status(500).json({ success: false, error: error.message || 'Failed to add expense' });
    }
});

apiRouter.get('/expenses', authenticate, async (req, res) => {
    try {
        const { year, month } = req.query;
        let expenses;
        
        if (year && month) {
            expenses = await dbOperations.getExpensesByMonth(year, month, req.user.userId);
        } else {
            expenses = await dbOperations.getAllExpenses(req.user.userId);
        }
        
        return res.json({ success: true, expenses: expenses || [] });
    } catch (error) {
        console.error('Get expenses error:', error);
        return res.status(500).json({ success: false, error: error.message || 'Failed to fetch expenses' });
    }
});

apiRouter.get('/report', authenticate, async (req, res) => {
    try {
        const now = new Date();
        const year = req.query.year || now.getFullYear();
        const month = req.query.month || (now.getMonth() + 1);
        
        const [monthlyExpenses, categoryTotals, monthlyTotals, budget] = await Promise.all([
            dbOperations.getExpensesByMonth(year, month, req.user.userId),
            dbOperations.getCategoryTotals(year, month, req.user.userId),
            dbOperations.getMonthlyTotals(req.user.userId),
            dbOperations.getUserBudget(req.user.userId)
        ]);

        const totalSpent = (monthlyExpenses || []).reduce((sum, exp) => sum + (parseFloat(exp.amount) || 0), 0);
        const insights = generateInsights(monthlyExpenses || [], categoryTotals || [], monthlyTotals || []);

        return res.json({
            success: true,
            period: { year, month },
            summary: {
                totalSpent,
                budget,
                remainingBudget: budget - totalSpent,
                budgetUtilization: budget > 0 ? (totalSpent / budget) * 100 : 0
            },
            categoryBreakdown: categoryTotals || [],
            monthlyTrends: monthlyTotals || [],
            insights
        });
    } catch (error) {
        console.error('Report error:', error);
        return res.status(500).json({ success: false, error: error.message || 'Failed to generate report' });
    }
});

apiRouter.get('/ai-insights', authenticate, async (req, res) => {
    try {
        const [expenses, categoryTotals, monthlyTotals] = await Promise.all([
            dbOperations.getAllExpenses(req.user.userId),
            dbOperations.getCategoryTotals(new Date().getFullYear(), new Date().getMonth() + 1, req.user.userId),
            dbOperations.getMonthlyTotals(req.user.userId)
        ]);

        const insights = generateInsights(expenses || [], categoryTotals || [], monthlyTotals || []);
        return res.json({ success: true, insights });
    } catch (error) {
        console.error('AI Insights error:', error);
        return res.status(500).json({ success: false, error: error.message || 'Failed to generate insights' });
    }
});

apiRouter.get('/budget', authenticate, async (req, res) => {
    try {
        const budget = await dbOperations.getUserBudget(req.user.userId);
        return res.json({ success: true, budget });
    } catch (error) {
        console.error('Get budget error:', error);
        return res.status(500).json({ success: false, error: error.message || 'Failed to get budget' });
    }
});

apiRouter.put('/budget', authenticate, async (req, res) => {
    try {
        const { budget } = req.body || {};
        if (budget === undefined || parseFloat(budget) < 0) {
            return res.status(400).json({ success: false, error: 'Valid positive budget amount is required' });
        }

        await dbOperations.updateUserBudget(req.user.userId, parseFloat(budget));
        return res.json({ success: true, message: 'Budget updated successfully', budget: parseFloat(budget) });
    } catch (error) {
        console.error('Update budget error:', error);
        return res.status(500).json({ success: false, error: error.message || 'Failed to update budget' });
    }
});

apiRouter.delete(['/expense/:id', '/expenses/:id'], authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await dbOperations.deleteExpense(id, req.user.userId);
        
        if (!result.deleted) {
            return res.status(404).json({ success: false, error: 'Expense not found or unauthorized' });
        }

        return res.json({ success: true, message: 'Expense deleted successfully' });
    } catch (error) {
        console.error('Delete expense error:', error);
        return res.status(500).json({ success: false, error: error.message || 'Failed to delete expense' });
    }
});

// Mount Router on BOTH '/api' and '/'
app.use('/api', apiRouter);
app.use('/', apiRouter);

// Global 404 handler (Always returns JSON, never HTML)
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: `API endpoint not found: ${req.method} ${req.originalUrl || req.url}`,
        code: 'ROUTE_NOT_FOUND'
    });
});

// Global Error Handler (Always returns JSON, never HTML)
app.use((err, req, res, next) => {
    console.error('Unhandled server exception:', err);
    res.status(err.status || 500).json({
        success: false,
        error: err.message || 'Internal Server Error',
        code: err.code || 'INTERNAL_ERROR'
    });
});

// Local dev server listener
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });
}

module.exports = app;
