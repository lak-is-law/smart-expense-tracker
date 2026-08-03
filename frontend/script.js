function getApiBaseUrl() {
    try {
        if (
            !window.location.origin ||
            window.location.origin === 'null' ||
            window.location.protocol === 'file:' ||
            window.location.hostname === 'localhost' ||
            window.location.hostname === '127.0.0.1' ||
            window.location.port !== ''
        ) {
            return 'http://localhost:3000';
        }
        return window.location.origin.replace(/\/+$/, '') + '/api';
    } catch (_) {
        return 'http://localhost:3000';
    }
}
const API_BASE_URL = getApiBaseUrl();

// Authentication Check
function checkAuth() {
    const token = localStorage.getItem('authToken');
    if (!token) {
        window.location.href = 'login.html';
        return null;
    }
    const userStr = localStorage.getItem('authUser');
    if (userStr) {
        try {
            const user = JSON.parse(userStr);
            const nameEl = document.getElementById('userNameDisplay');
            if (nameEl && user.name) {
                nameEl.textContent = user.name;
            }
        } catch (_) {}
    }
    return token;
}

// Authenticated Fetch Wrapper
async function authFetch(endpoint, options = {}) {
    const token = checkAuth();
    if (!token) return null;

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...(options.headers || {})
    };

    try {
        const response = await fetch(`${API_BASE_URL}${endpoint}`, {
            ...options,
            headers
        });

        if (response.status === 401) {
            localStorage.removeItem('authToken');
            localStorage.removeItem('authUser');
            window.location.href = 'login.html';
            return null;
        }

        return response;
    } catch (err) {
        console.error(`API error on ${endpoint}:`, err);
        throw err;
    }
}

function handleLogout() {
    localStorage.removeItem('authToken');
    localStorage.removeItem('authUser');
    window.location.href = 'login.html';
}

// Initialize app
document.addEventListener('DOMContentLoaded', function() {
    if (!checkAuth()) return;
    setupNavigation();
    setupForm();
    setupThemeSwitcher();
    loadDashboard();
});

// Setup navigation
function setupNavigation() {
    const navButtons = document.querySelectorAll('.nav-btn');
    navButtons.forEach(button => {
        button.addEventListener('click', () => {
            const section = button.dataset.section;
            switchSection(section);
        });
    });
}

// Switch sections
function switchSection(sectionName) {
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.section === sectionName) {
            btn.classList.add('active');
        }
    });

    document.querySelectorAll('.content-section').forEach(section => {
        section.classList.remove('active');
        if (section.id === sectionName) {
            section.classList.add('active');
        }
    });

    if (sectionName === 'dashboard') loadDashboard();
    if (sectionName === 'expenses') loadExpenses();
    if (sectionName === 'insights') loadAIInsights();
}

// Setup form
function setupForm() {
    const form = document.getElementById('expenseForm');
    if (form) {
        form.addEventListener('submit', handleAddExpense);
    }
}

// Load dashboard
async function loadDashboard() {
    try {
        const response = await authFetch('/report');
        if (!response) return;
        const data = await response.json();
        updateDashboard(data);
    } catch (error) {
        console.error('Error loading dashboard:', error);
    }
}

// Update dashboard
function updateDashboard(data) {
    document.getElementById('totalSpending').textContent = `₹${data.totalSpending || 0}`;
    document.getElementById('expenseCount').textContent = (data.expenses || []).length;
    
    const limit = data.budgetLimit || 5000;
    const progress = Math.min(100, Math.round(((data.totalSpending || 0) / limit) * 100));
    document.getElementById('budgetProgress').textContent = `${progress}%`;
    document.getElementById('budgetLimitLabel').textContent = `Limit: ₹${limit}`;

    if (data.isOverBudget) {
        document.getElementById('warningBanner').style.display = 'flex';
        document.getElementById('warningText').textContent = `Monthly spending (₹${data.totalSpending}) exceeds budget of ₹${limit}!`;
    } else {
        document.getElementById('warningBanner').style.display = 'none';
    }

    updateCategoryList(data.categoryTotals || []);
    updateTrendList(data.monthlyTotals || []);
}

// Update category list
function updateCategoryList(categories) {
    const list = document.getElementById('categoryList');
    list.innerHTML = '';
    
    if (!categories || categories.length === 0) {
        list.innerHTML = '<p style="color: #64748b; font-size: 0.9rem;">No category data yet.</p>';
        return;
    }

    categories.forEach(cat => {
        const item = document.createElement('div');
        item.className = 'category-item';
        item.innerHTML = `
            <span>${cat.category}</span>
            <span>₹${cat.total}</span>
        `;
        list.appendChild(item);
    });
}

function updateTrendList(monthlyTotals) {
    const container = document.getElementById('trendChartList');
    if (!container) return;
    container.innerHTML = '';

    if (!monthlyTotals || monthlyTotals.length === 0) {
        container.innerHTML = '<p style="color: #64748b; font-size: 0.9rem;">No trend data available.</p>';
        return;
    }

    monthlyTotals.forEach(m => {
        const item = document.createElement('div');
        item.className = 'category-item';
        item.innerHTML = `
            <span><i class="fas fa-calendar-alt" style="margin-right: 8px; color: #38bdf8;"></i>${m.month}</span>
            <span style="font-weight: 600;">₹${m.total}</span>
        `;
        container.appendChild(item);
    });
}

// Load expenses
async function loadExpenses() {
    try {
        const response = await authFetch('/expenses');
        if (!response) return;
        const expenses = await response.json();
        updateExpensesTable(expenses);
    } catch (error) {
        console.error('Error loading expenses:', error);
    }
}

// Update expenses table
function updateExpensesTable(expenses) {
    const tbody = document.getElementById('expensesTableBody');
    tbody.innerHTML = '';
    
    if (!expenses || expenses.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #64748b; padding: 2rem;">No expenses found. Add your first expense above!</td></tr>';
        return;
    }

    expenses.forEach(exp => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${new Date(exp.date).toLocaleDateString()}</td>
            <td><span class="category-badge">${exp.category}</span></td>
            <td>${exp.description || '-'}</td>
            <td style="font-weight: 600;">₹${exp.amount}</td>
            <td>
                <button class="delete-btn" onclick="handleDeleteExpense(${exp.id})" style="background: none; border: none; color: #ef4444; cursor: pointer;">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        `;
        tbody.appendChild(row);
    });
}

async function handleDeleteExpense(id) {
    if (!confirm('Are you sure you want to delete this expense?')) return;
    try {
        const response = await authFetch(`/expenses/${id}`, { method: 'DELETE' });
        if (response && response.ok) {
            loadExpenses();
            loadDashboard();
        }
    } catch (err) {
        alert('Failed to delete expense');
    }
}

// Load AI insights
async function loadAIInsights() {
    try {
        const response = await authFetch('/ai-insights');
        if (!response) return;
        const data = await response.json();
        updateInsights(data.insights);
    } catch (error) {
        console.error('Error loading insights:', error);
    }
}

// Update insights
function updateInsights(insights) {
    if (!insights) return;
    document.getElementById('predictionsContent').innerHTML = 
        `<p style="font-size: 1.2rem; font-weight: 600; color: #38bdf8;">Next month projected: ₹${insights.predictions?.nextMonth || 0}</p>`;
    
    document.getElementById('nextMonthPrediction').textContent = `₹${insights.predictions?.nextMonth || 0}`;

    const recs = insights.recommendations || [];
    document.getElementById('recommendationsContent').innerHTML = recs.length > 0
        ? recs.map(r => `<p style="margin-bottom: 0.5rem;">• ${r}</p>`).join('')
        : '<p style="color: #64748b;">No recommendations yet. Add more expense records to generate AI advice.</p>';
    
    const anoms = insights.anomalies || [];
    document.getElementById('anomaliesContent').innerHTML = anoms.length > 0
        ? anoms.map(a => `<p style="margin-bottom: 0.5rem; color: #f87171;">• ₹${a.amount} on ${a.date} (${a.description || 'No description'})</p>`).join('')
        : '<p style="color: #64748b;">No unusual spending anomalies detected.</p>';

    document.getElementById('trendAnalysisContent').innerHTML = 
        `<p>Your average monthly trends are calculated based on your historical records.</p>`;
}

// Handle add expense
async function handleAddExpense(event) {
    event.preventDefault();
    
    const formData = new FormData(event.target);
    const expense = {
        date: formData.get('date'),
        category: formData.get('category'),
        amount: parseFloat(formData.get('amount')),
        description: formData.get('description')
    };

    try {
        const response = await authFetch('/add-expense', {
            method: 'POST',
            body: JSON.stringify(expense)
        });

        if (response && response.ok) {
            hideAddExpenseModal();
            event.target.reset();
            loadDashboard();
            loadExpenses();
            loadAIInsights();
        } else {
            const err = await response.json();
            alert(err.error || 'Failed to add expense');
        }
    } catch (error) {
        console.error('Error adding expense:', error);
    }
}

async function promptSetBudget() {
    const current = prompt('Enter your monthly budget limit (in ₹):', '5000');
    if (!current || isNaN(current) || parseFloat(current) <= 0) return;

    try {
        const res = await authFetch('/budget', {
            method: 'PUT',
            body: JSON.stringify({ budget: parseFloat(current) })
        });
        if (res && res.ok) {
            loadDashboard();
        }
    } catch (err) {
        alert('Failed to update budget');
    }
}

// Modal functions
function showAddExpenseModal() {
    document.getElementById('addExpenseModal').classList.add('active');
    document.getElementById('expenseDate').value = new Date().toISOString().split('T')[0];
}

function hideAddExpenseModal() {
    document.getElementById('addExpenseModal').classList.remove('active');
}

// Theme Switcher Functions
function setupThemeSwitcher() {
    const themeButtons = document.querySelectorAll('.theme-btn');
    const savedTheme = localStorage.getItem('selectedTheme') || 'default';
    applyTheme(savedTheme);
    
    themeButtons.forEach(button => {
        button.addEventListener('click', () => {
            const theme = button.dataset.theme;
            if (theme) {
                applyTheme(theme);
                localStorage.setItem('selectedTheme', theme);
            }
        });
    });
}

function applyTheme(theme) {
    document.documentElement.removeAttribute('data-theme');
    if (theme !== 'default') {
        document.documentElement.setAttribute('data-theme', theme);
    }
    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.theme === theme) {
            btn.classList.add('active');
        }
    });
}
