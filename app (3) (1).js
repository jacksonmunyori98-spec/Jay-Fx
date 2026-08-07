// --- Configuration & State ---
const DEFAULT_APP_ID = "3434rVEmE5lATKuLgLVFw"; // Updated to your modern App ID
let appId = localStorage.getItem('kelvin_app_id') || DEFAULT_APP_ID;
let apiToken = localStorage.getItem('kelvin_api_token') || null;
let accountId = localStorage.getItem('kelvin_account_id') || null; // NEW: Required for Modern API

let ws = null;
let isConnected = false;
let activeMarket = 'R_100'; // Default market
let activeSubId = null;
let intentionallyClosed = false;

const markets = [
    { id: 'R_100', name: 'VOLATILITY 100 INDEX' },
    { id: 'R_75', name: 'VOLATILITY 75 INDEX' },
    { id: 'R_50', name: 'VOLATILITY 50 INDEX' },
    { id: 'R_25', name: 'VOLATILITY 25 INDEX' },
    { id: 'frxEURUSD', name: 'EUR/USD' },
    { id: 'frxGBPUSD', name: 'GBP/USD' },
    { id: 'cryBTCUSD', name: 'BTC/USD' }
];

// Market Data State
let tickHistory = [];
const HISTORY_LIMIT = 30;
let currentPrice = null;

// Prediction State
let predType = 'rise_fall'; // 'rise_fall', 'even_odd', 'over_under'
let predDigit = 0;
let predDuration = 3; // ticks

// History & Stats
let predictions = JSON.parse(localStorage.getItem('kelvin_predictions')) || [];
let activePrediction = null; // Currently running prediction

// --- DOM Elements ---
const elGlobalStatusDot = document.getElementById('global-status-dot');
const elGlobalStatusText = document.getElementById('global-status-text');
const elMarketStatusDot = document.getElementById('market-status-dot');
const elMarketStatusText = document.getElementById('market-status-text');
const elLoginBtn = document.getElementById('login-modal-btn');
const elAuthWarning = document.getElementById('auth-warning');

const elHeaderMarkets = document.getElementById('header-markets');
const elMarketCards = document.getElementById('market-cards');
const elActiveMarketName = document.getElementById('active-market-name');
const elCurrentPriceDisplay = document.getElementById('current-price-display');

const elMomentumVal = document.getElementById('momentum-val');
const elMomentumLabel = document.getElementById('momentum-label');
const elGaugeNeedle = document.getElementById('gauge-needle');

const elPredictionTypeBtns = document.querySelectorAll('#prediction-type .toggle-btn');
const elDigitGroup = document.getElementById('digit-selection-group');
const elDigitBtns = document.querySelectorAll('#digit-value .toggle-btn');
const elDurationBtns = document.querySelectorAll('#duration-ticks .toggle-btn');
const elBtnUp = document.getElementById('btn-up');
const elBtnDown = document.getElementById('btn-down');

const elAccuracyBar = document.getElementById('accuracy-bar');
const elAccuracyText = document.getElementById('accuracy-text');
const elAccuracySubtext = document.getElementById('accuracy-subtext');
const elHistoryList = document.getElementById('history-list');

const elLoginModal = document.getElementById('login-modal');
const elCancelLogin = document.getElementById('cancel-login');
const elSubmitLogin = document.getElementById('submit-login');
const elInputAppId = document.getElementById('app-id');
const elInputApiToken = document.getElementById('api-token');

const elBanner = document.getElementById('prediction-banner');
const elBannerText = document.getElementById('banner-text');

const elShowLogBtn = document.getElementById('show-log-btn');
const elLogModal = document.getElementById('log-modal');
const elCloseLogBtn = document.getElementById('close-log-btn');
const elLogContainer = document.getElementById('log-container');

let connectionLogs = [];

function addLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const logStr = `[${time}] ${msg}`;
    connectionLogs.push({ str: logStr, type });
    console[type === 'error' ? 'error' : 'log'](msg);

    if (elLogContainer) {
        const span = document.createElement('div');
        span.textContent = logStr;
        span.style.color = type === 'error' ? '#FF4C4C' : 'inherit';
        elLogContainer.appendChild(span);
        elLogContainer.scrollTop = elLogContainer.scrollHeight;
    }
}

// --- Initialization ---
function init() {
    renderMarketSelectors();
    updateAuthUI();
    connectWS();
    updateStatsUI();
    setupEventListeners();
}

// --- WebSocket & Deriv API (MODERN FLOW) ---
async function connectWS() {
    if (ws) {
        ws.onclose = null; // Prevent old ws from triggering reconnect
        ws.close();
    }

    intentionallyClosed = false;
    updateConnectionStatus('connecting');

    // Default to the new public endpoint for unauthenticated market data
    let wsUrl = `wss://api.derivws.com/trading/v1/options/ws/public`;

    // If we have credentials, execute the REST OTP flow first
    if (apiToken && accountId) {
        addLog('Requesting OTP via REST API...');
        try {
            const response = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${accountId}/otp`, {
                method: 'POST',
                headers: {
                    'Deriv-App-ID': appId,
                    'Authorization': `Bearer ${apiToken}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.errors?.[0]?.message || 'Failed to fetch OTP');
            }

            const { data } = await response.json();
            wsUrl = data.url; // This URL contains the OTP embedded as a parameter
            addLog('OTP received. Connecting to authenticated socket...');

        } catch (error) {
            addLog(`Auth Error: ${error.message}`, 'error');
            intentionallyClosed = true;
            logout(); // Clear bad credentials
            return;
        }
    } else {
        addLog('Connecting to public socket (read-only)...');
    }

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        updateConnectionStatus('connected');
        addLog('WebSocket connection opened');

        // With the modern API, we request symbols with product_type: 'basic'
        ws.send(JSON.stringify({ active_symbols: 'brief', product_type: 'basic' }));
        
        // Setup ping keep-alive every 25 seconds
        pingInterval = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ ping: 1 }));
            }
        }, 25000);
    };

    ws.onmessage = (msg) => {
        const data = JSON.parse(msg.data);

        if (data.error) {
            addLog(`API Error: ${data.error.message} (Code: ${data.error.code})`, 'error');
            return;
        }

        if (data.msg_type === 'ping') {
            return; // Ignore ping responses
        }

        if (data.msg_type === 'active_symbols') {
            const symbols = data.active_symbols || [];
            if (symbols.length === 0) {
                addLog(`Warning: 0 active symbols available!`, 'error');
                intentionallyClosed = true;
                ws.close();
                return;
            }

            // Log what we received so we can see the exact format
            const someSymbols = symbols.slice(0, 10).map(s => s.symbol || s.instrument_code || s.name || JSON.stringify(s)).join(', ');
            addLog(`Found ${symbols.length} symbols. Examples: ${someSymbols.substring(0, 100)}`);

            // Dynamically update the markets list with what Deriv returned
            // We look for 'symbol' but fallback to 'instrument_code' just in case the new API changed keys
            const newMarkets = symbols.filter(s => 
                (s.market === 'synthetic_index' || s.market === 'forex' || !s.market)
            ).map(s => ({
                id: s.symbol || s.instrument_code,
                name: s.display_name || s.name || s.symbol || s.instrument_code
            }));
            
            if (newMarkets.length > 0) {
                // Keep favorites if they exist
                const favoriteIds = ['R_100', 'R_75', '1HZ100V', '1HZ75V', 'frxEURUSD'];
                const filtered = newMarkets.filter(m => favoriteIds.includes(m.id));
                if (filtered.length > 0) {
                    markets = filtered; // Update global markets array
                }
                renderMarketSelectors();
            }

            // Check if activeMarket is valid in the NEW format
            const isValid = newMarkets.some(m => m.id === activeMarket);

            if (isValid) {
                subscribeToMarket(activeMarket);
            } else {
                addLog(`Symbol ${activeMarket} is not supported. Auto-switching to first available...`, 'error');
                const firstAvailable = newMarkets[0].id;
                activeMarket = firstAvailable;

                const marketObj = markets.find(m => m.id === firstAvailable);
                elActiveMarketName.textContent = marketObj ? marketObj.name : firstAvailable;

                renderMarketSelectors();
                subscribeToMarket(activeMarket);
            }
        }

        if (data.msg_type === 'tick') {
            handleTick(data.tick);
        }

        if (data.msg_type === 'buy') {
            console.log("Trade placed successfully:", data.buy);
            addLog(`Trade placed successfully: ${data.buy.contract_id}`);
        }
    };

    ws.onclose = () => {
        if (pingInterval) clearInterval(pingInterval);
        updateConnectionStatus('disconnected');
        if (intentionallyClosed) {
            addLog('WebSocket connection closed cleanly. Not reconnecting.', 'error');
            return;
        }
        addLog('WebSocket connection closed. Reconnecting...', 'error');
        setTimeout(connectWS, 3000);
    };

    ws.onerror = (err) => {
        addLog("WebSocket Error occurred.", 'error');
    };
}

function updateConnectionStatus(status) {
    isConnected = status === 'connected';
    const classList = ['status-indicator', status];
    const text = status === 'connected' ? 'connected' : (status === 'connecting' ? 'reconnecting...' : 'disconnected');

    elGlobalStatusDot.className = classList.join(' ');
    elGlobalStatusText.textContent = text;
    elMarketStatusDot.className = classList.join(' ');
    elMarketStatusText.textContent = text;
}

function subscribeToMarket(marketId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    // Unsubscribe previous
    if (activeSubId) {
        ws.send(JSON.stringify({ forget: activeSubId }));
    }

    // Clear history
    tickHistory = [];
    currentPrice = null;
    elCurrentPriceDisplay.textContent = 'waiting for data...';
    updateGaugeUI();

    // Subscribe new
    addLog(`Subscribing to market: ${marketId}`);
    ws.send(JSON.stringify({
        ticks: marketId,
        subscribe: 1
    }));
}

// --- Data Handling ---
function handleTick(tick) {
    const price = tick.quote;
    activeSubId = tick.id;

    if (currentPrice !== null) {
        const direction = price > currentPrice ? 1 : (price < currentPrice ? -1 : 0);
        tickHistory.push({ price, direction });
        if (tickHistory.length > HISTORY_LIMIT) {
            tickHistory.shift();
        }
    } else {
        tickHistory.push({ price, direction: 0 });
    }

    currentPrice = price;
    elCurrentPriceDisplay.textContent = price.toFixed(5);

    // Update gauge
    updateGaugeUI();

    // Check active prediction
    checkActivePrediction();
}

function updateGaugeUI() {
    if (tickHistory.length < 2) {
        setGaugeValue(50, 'neutral');
        return;
    }

    // Calculate momentum: percentage of ticks that went UP out of total moves
    let upCount = 0;
    let validMoves = 0;
    for (let i = 1; i < tickHistory.length; i++) {
        if (tickHistory[i].direction !== 0) {
            validMoves++;
            if (tickHistory[i].direction === 1) upCount++;
        }
    }

    if (validMoves === 0) {
        setGaugeValue(50, 'neutral');
        return;
    }

    const momentumPercent = Math.round((upCount / validMoves) * 100);
    let label = 'neutral';
    if (momentumPercent > 70) label = 'hot';
    else if (momentumPercent > 55) label = 'warm';
    else if (momentumPercent < 30) label = 'cold';
    else if (momentumPercent < 45) label = 'cool';

    setGaugeValue(momentumPercent, label);
}

function setGaugeValue(percent, label) {
    elMomentumVal.textContent = `${percent}K`;
    elMomentumLabel.textContent = label;

    // Convert 0-100 to -90deg to 90deg
    const angle = (percent / 100) * 180 - 90;
    elGaugeNeedle.style.transform = `rotate(${angle}deg)`;
}

// --- Prediction Logic ---
function placePrediction(action) {
    if (activePrediction) {
        alert("A prediction is already running.");
        return;
    }

    if (currentPrice === null) {
        alert("Waiting for market data...");
        return;
    }

    const currentMomentumText = elMomentumVal.textContent;
    const momentumVal = parseInt(currentMomentumText.replace('K', ''));

    let withTrend = false;
    if (action === 'up' && momentumVal >= 50) withTrend = true;
    if (action === 'down' && momentumVal <= 50) withTrend = true;

    if (apiToken) {
        console.log("Placing REAL trade for", action);
    }

    activePrediction = {
        market: activeMarket,
        startPrice: currentPrice,
        type: predType,
        digit: predDigit,
        action: action,
        targetTicks: predDuration,
        ticksPassed: 0,
        withTrend: withTrend,
        timestamp: new Date().getTime()
    };

    showBanner(`Prediction locked in!`, 'sawa');
}

function checkActivePrediction() {
    if (!activePrediction) return;

    activePrediction.ticksPassed++;

    if (activePrediction.ticksPassed >= activePrediction.targetTicks) {
        resolvePrediction();
    }
}

function resolvePrediction() {
    const endPrice = currentPrice;
    const startPrice = activePrediction.startPrice;
    let isWin = false;

    if (activePrediction.type === 'rise_fall') {
        if (activePrediction.action === 'up') isWin = endPrice > startPrice;
        if (activePrediction.action === 'down') isWin = endPrice < startPrice;
    }
    else if (activePrediction.type === 'even_odd') {
        const lastDigit = parseInt(endPrice.toString().slice(-1));
        const isEven = lastDigit % 2 === 0;
        if (activePrediction.action === 'up') isWin = isEven;
        if (activePrediction.action === 'down') isWin = !isEven;
    }
    else if (activePrediction.type === 'over_under') {
        const lastDigit = parseInt(endPrice.toString().slice(-1));
        if (activePrediction.action === 'up') isWin = lastDigit > activePrediction.digit;
        if (activePrediction.action === 'down') isWin = lastDigit < activePrediction.digit;
    }

    if (activePrediction.withTrend) {
        showBanner('Iko Sawa (Trend Aligned)', 'sawa');
    } else {
        showBanner('Iko Mbaya (Against Trend)', 'mbaya');
    }

    predictions.unshift({
        market: activePrediction.market,
        type: activePrediction.type,
        action: activePrediction.action,
        isWin: isWin,
        date: new Date().toLocaleString()
    });

    if (predictions.length > 50) predictions.pop();
    localStorage.setItem('kelvin_predictions', JSON.stringify(predictions));

    activePrediction = null;
    updateStatsUI();
}

// --- UI Updates ---
function updateStatsUI() {
    elHistoryList.innerHTML = '';

    if (predictions.length === 0) {
        elHistoryList.innerHTML = '<div class="empty-state">no predictions yet</div>';
        elAccuracyText.textContent = '—%';
        elAccuracyBar.style.width = '0%';
        elAccuracySubtext.textContent = 'no predictions yet';
        return;
    }

    let wins = 0;
    predictions.forEach(p => {
        if (p.isWin) wins++;

        const el = document.createElement('div');
        el.className = 'history-item';

        let actionText = '';
        if (p.type === 'rise_fall') actionText = p.action === 'up' ? 'Rise' : 'Fall';
        if (p.type === 'even_odd') actionText = p.action === 'up' ? 'Even' : 'Odd';
        if (p.type === 'over_under') actionText = p.action === 'up' ? 'Over' : 'Under';

        const outcomeClass = p.isWin ? 'win' : 'loss';
        const outcomeText = p.isWin ? 'WON' : 'LOST';

        el.innerHTML = `
            <span>${p.market} - ${actionText}</span>
            <span class="outcome ${outcomeClass}">${outcomeText}</span>
        `;
        elHistoryList.appendChild(el);
    });

    const accuracy = Math.round((wins / predictions.length) * 100);
    elAccuracyText.textContent = `${accuracy}%`;
    elAccuracyBar.style.width = `${accuracy}%`;
    elAccuracySubtext.textContent = `${wins} won out of ${predictions.length}`;
}

function showBanner(text, type) {
    elBannerText.textContent = text;
    elBanner.className = `notification-banner ${type}`;
    elBanner.style.display = 'block';

    setTimeout(() => {
        elBanner.style.display = 'none';
    }, 3000);
}

function renderMarketSelectors() {
    elHeaderMarkets.innerHTML = '';
    elMarketCards.innerHTML = '';

    markets.forEach(m => {
        const pill = document.createElement('button');
        pill.className = `market-pill ${m.id === activeMarket ? 'active' : ''}`;
        pill.textContent = m.id;
        pill.onclick = () => selectMarket(m.id);
        elHeaderMarkets.appendChild(pill);

        const card = document.createElement('div');
        card.className = `m-card ${m.id === activeMarket ? 'active' : ''}`;
        card.onclick = () => selectMarket(m.id);
        card.innerHTML = `
            <h3>${m.id}</h3>
            <div class="m-price" id="card-price-${m.id}">-</div>
            <div class="m-trend">trend</div>
        `;
        elMarketCards.appendChild(card);
    });
}

function selectMarket(marketId) {
    activeMarket = marketId;
    const marketObj = markets.find(m => m.id === marketId);
    elActiveMarketName.textContent = marketObj.name;

    renderMarketSelectors();
    subscribeToMarket(marketId);
}

// --- Auth & Login ---
function updateAuthUI() {
    if (apiToken) {
        elLoginBtn.textContent = 'Logged In';
        elLoginBtn.style.backgroundColor = 'var(--panel-bg)';
        elLoginBtn.style.color = 'var(--text-secondary)';
        elAuthWarning.style.display = 'none';
    } else {
        elLoginBtn.textContent = 'Login to Deriv';
        elLoginBtn.style.backgroundColor = 'var(--accent-yellow)';
        elLoginBtn.style.color = '#000';
        elAuthWarning.style.display = 'block';
    }
}

function logout() {
    apiToken = null;
    accountId = null;
    appId = DEFAULT_APP_ID;
    localStorage.removeItem('kelvin_api_token');
    localStorage.removeItem('kelvin_app_id');
    localStorage.removeItem('kelvin_account_id');
    updateAuthUI();
    connectWS();
}

// --- Event Listeners Setup ---
function setupEventListeners() {
    elPredictionTypeBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            elPredictionTypeBtns.forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            predType = e.target.dataset.val;

            if (predType === 'rise_fall') {
                elDigitGroup.style.display = 'none';
                elBtnUp.textContent = '↑ Predict Rise';
                elBtnDown.textContent = '↓ Predict Fall';
            } else if (predType === 'even_odd') {
                elDigitGroup.style.display = 'none';
                elBtnUp.textContent = 'Even';
                elBtnDown.textContent = 'Odd';
            } else if (predType === 'over_under') {
                elDigitGroup.style.display = 'block';
                elBtnUp.textContent = 'Predict Over';
                elBtnDown.textContent = 'Predict Under';
            }
        });
    });

    elDigitBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            elDigitBtns.forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            predDigit = parseInt(e.target.dataset.val);
        });
    });

    elDurationBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            elDurationBtns.forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            predDuration = parseInt(e.target.dataset.val);
        });
    });

    elBtnUp.addEventListener('click', () => placePrediction('up'));
    elBtnDown.addEventListener('click', () => placePrediction('down'));

    elLoginBtn.addEventListener('click', () => {
        if (apiToken) {
            if (confirm("Are you sure you want to log out?")) logout();
        } else {
            elLoginModal.style.display = 'flex';
        }
    });

    elCancelLogin.addEventListener('click', () => {
        elLoginModal.style.display = 'none';
    });

    elSubmitLogin.addEventListener('click', () => {
        const idVal = elInputAppId.value.trim();
        const tokenVal = elInputApiToken.value.trim();

        // NEW: We prompt for the Account ID since it's required for the Modern API REST request.
        // If you prefer, you can add an explicit `<input id="account-id">` into your HTML later.
        const accIdVal = prompt("Enter your Deriv Account ID (e.g., VRTC1234567, CR1234567) to generate the modern OTP:", accountId) || "";

        if (idVal && tokenVal && accIdVal) {
            appId = idVal;
            apiToken = tokenVal;
            accountId = accIdVal.trim();

            localStorage.setItem('kelvin_app_id', appId);
            localStorage.setItem('kelvin_api_token', apiToken);
            localStorage.setItem('kelvin_account_id', accountId); // Save for future sessions

            elLoginModal.style.display = 'none';
            addLog(`Saved login info (AppID: ${appId}, Account: ${accountId})`);
            updateAuthUI();
            connectWS();
        } else {
            alert("Please enter App ID, API Token, and Account ID.");
        }
    });

    if (elShowLogBtn) {
        elShowLogBtn.addEventListener('click', () => {
            elLogModal.style.display = 'flex';
        });
    }

    if (elCloseLogBtn) {
        elCloseLogBtn.addEventListener('click', () => {
            elLogModal.style.display = 'none';
        });
    }
}

// Start app
init();