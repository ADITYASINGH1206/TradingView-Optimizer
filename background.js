let permutations = [];
let results = [];
let currentIndex = 0;
let targetTabId = null;
let optimizationTarget = "Net Profit";
let currentStrategyName = "Unknown_Strategy";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "start_optimization") {
        permutations = message.permutations;
        optimizationTarget = message.target;
        currentStrategyName = message.strategyName || "Unknown_Strategy";
        results = [];
        currentIndex = 0;

        chrome.storage.local.set({ 
            optQueue: permutations, 
            optResults: results, 
            optCurrentIndex: currentIndex,
            optTarget: optimizationTarget
        });

        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs.length > 0) {
                targetTabId = tabs[0].id;
                runNext();
            }
        });
    }

    if (message.action === "permutation_result") {
        const currentPerm = permutations[currentIndex];
        
        // Merge the permutation inputs with the scraper metrics results
        // This ensures the CSV has both side-by-side
        results.push({
            ...currentPerm,
            ...message.data
        });

        currentIndex++;

        chrome.storage.local.set({ 
            optResults: results, 
            optCurrentIndex: currentIndex 
        });

        runNext();
    }
});

function runNext() {
    if (currentIndex < permutations.length) {
        // Update the on-screen UI banner in the content script
        chrome.tabs.sendMessage(targetTabId, {
            action: "progress_update",
            current: currentIndex + 1,
            total: permutations.length
        });

        chrome.tabs.sendMessage(targetTabId, {
            action: "run_permutation",
            permutation: permutations[currentIndex]
        });
    } else {
        finishOptimization();
    }
}

function parseMetric(valString) {
    if (!valString || valString === "ERR" || valString === "ERROR" || valString === "0") return 0;
    const cleaned = valString.replace(/[^\d.-]/g, '');
    return parseFloat(cleaned) || 0;
}

function getFormattedDateString() {
    const now = new Date();
    const DD = String(now.getDate()).padStart(2, '0');
    const MM = String(now.getMonth() + 1).padStart(2, '0');
    const YY = String(now.getFullYear()).toString().slice(-2);
    const HH = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    
    return `${DD}_${MM}_${YY}_${HH}${mm}`;
}

function finishOptimization() {
    chrome.tabs.sendMessage(targetTabId, { action: "finish_optimization" });
    chrome.storage.local.remove(['optQueue', 'optResults', 'optCurrentIndex', 'optTarget']);

    if (results.length === 0) return;

    // Sorting logic for all new metrics
    results.sort((a, b) => {
        const valA = parseMetric(a[optimizationTarget]);
        const valB = parseMetric(b[optimizationTarget]);

        if (optimizationTarget && (optimizationTarget.includes("Drawdown") || optimizationTarget.includes("Loss"))) {
            return Math.abs(valA) - Math.abs(valB); // Lower is better for Drawdown/Loss
        }
        return valB - valA; // Higher is better for Profit/Factor
    });

    // Define a professional order for the CSV columns
    const staticParams = permutations.length > 0 ? Object.keys(permutations[0]) : [];
    const metricOrder = [
        "Net Profit", "Net Profit (%)",
        "Max Drawdown", "Max Drawdown (%)",
        "Profit Factor", "Percent Profitable"
    ];

    // Combine parameters followed by metrics in the specific order
    const allKeysInRow = [...staticParams];
    metricOrder.forEach(m => {
        if (!allKeysInRow.includes(m)) allKeysInRow.push(m);
    });

    // Add any unexpected keys found in results
    const anyOtherKeys = [...new Set(results.flatMap(obj => Object.keys(obj)))]
        .filter(k => !allKeysInRow.includes(k));
    
    const finalHeaderKeys = [...allKeysInRow, ...anyOtherKeys];

    let csvContent = "\uFEFF"; 
    csvContent += finalHeaderKeys.join(",") + "\r\n";
    
    results.forEach(rowObject => {
        let row = finalHeaderKeys.map(k => {
            let val = rowObject[k] || "N/A";
            if (typeof val === 'string') {
                val = val.replace(/"/g, '""');
                if (val.includes(",") || val.includes("\n")) val = `"${val}"`;
            }
            return val;
        });
        csvContent += row.join(",") + "\r\n";
    });

    const encodedUri = "data:text/csv;charset=utf-8," + encodeURIComponent(csvContent);
    
    // Strict Filename: StrategyName_DD_MM_YY_HHMM.csv
    const dateStr = getFormattedDateString();
    
    // Sanitize the strategy name: replace non-alphanumeric with underscores, avoid consecutive underscores
    const sanitizedName = currentStrategyName.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    const finalFilename = `${sanitizedName || "Strategy"}_${dateStr}.csv`;

    chrome.downloads.download({
        url: encodedUri,
        filename: finalFilename,
        saveAs: true
    });
}
