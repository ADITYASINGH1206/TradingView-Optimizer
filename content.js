let currentPollCount = 0;
let globalStaleValue = null;
let hasSeenLoadingTransition = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "scan") {
        (async () => {
            const modal = document.querySelector('div[data-name="indicator-properties-dialog"]');
            if (!modal) {
                sendResponse({ inputs: null, error: "Settings modal not found. Please manually open the Strategy Settings dialog first." });
                return;
            }

            await ensureInputsTabActive(modal);

            // Extract Strategy Name from the modal header
            const titleEl = modal.querySelector('[data-name="dialog-title"], [class*="title-"], .js-dialog__title');
            const strategyName = titleEl ? titleEl.innerText.trim() : "Unknown_Strategy";

            const inputs = Array.from(modal.querySelectorAll('input:not([type="hidden"])'));
            const result = [];

            inputs.forEach((inp, idx) => {
                let labelEl = null;
                const row = inp.closest('tr') || inp.closest('.tv-control-row') || inp.closest('[class*="row-"]');
                if (row) {
                    labelEl = row.querySelector('.tv-control-checkbox__label') || row.querySelector('div[class*="title-"]');
                }

                if (!labelEl) {
                    const parent = inp.parentElement;
                    if (parent && parent.previousElementSibling) {
                        labelEl = parent.previousElementSibling;
                    }
                }

                const labelText = labelEl ? labelEl.innerText.trim() : `Input ${idx}`;

                result.push({
                    name: `input_${idx}`,
                    label: labelText,
                    type: inp.type,
                    value: inp.value,
                    checked: inp.checked
                });
            });

            sendResponse({ inputs: result, strategyName: strategyName });
        })();
        return true; 
    }


    if (message.action === "run_permutation") {
        runPermutation(message.permutation);
        sendResponse({ status: "started" });
    }

    if (message.action === "progress_update") {
        updateProgressBanner(message.current, message.total);
    }

    if (message.action === "finish_optimization") {
        const banner = document.getElementById('tv-optimizer-banner');
        if (banner) banner.remove();
    }

    return true; 
});

function updateProgressBanner(current, total) {
    let banner = document.getElementById('tv-optimizer-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'tv-optimizer-banner';
        Object.assign(banner.style, {
            position: 'fixed',
            top: '20px',
            right: '20px',
            backgroundColor: '#2962FF',
            color: 'white',
            padding: '12px 20px',
            borderRadius: '8px',
            zIndex: '999999',
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            fontSize: '14px',
            fontWeight: '600',
            border: '1px solid rgba(255,255,255,0.2)'
        });
        document.body.appendChild(banner);
    }
    const percent = Math.round((current / total) * 100);
    banner.innerHTML = `
        <div style="margin-bottom: 5px;">Optimizer Running...</div>
        <div style="font-size: 18px;">${current} / ${total} (${percent}%)</div>
    `;
}

async function runPermutation(permutation) {
    let modal = document.querySelector('div[data-name="indicator-properties-dialog"]');
    
    // Attempt to open the modal if it's missing
    if (!modal) {
        const gearIcons = Array.from(document.querySelectorAll('[data-name="legend-settings-action"], button[aria-label="Settings"], .js-settings-button'));
        if (gearIcons.length > 0) {
            for (let icon of gearIcons) {
                icon.click();
                await new Promise(resolve => setTimeout(resolve, 1000));
                modal = document.querySelector('div[data-name="indicator-properties-dialog"]');
                if (modal) break;
            }
        }
    }

    if (!modal) {
        chrome.runtime.sendMessage({ action: "permutation_result", data: { error: "Modal not found. Please ensure the Strategy Settings dialog is open." } });
        return;
    }

    await ensureInputsTabActive(modal);

    const inputs = Array.from(modal.querySelectorAll('input:not([type="hidden"])'));
    
    for (const [key, val] of Object.entries(permutation)) {
        if (key.startsWith("input_")) {
            const index = parseInt(key.split("_")[1]);
            const inp = inputs[index];
            if (inp) {
                inp.focus();
                if (inp.type === 'checkbox') {
                    const targetValue = val === "true" || val === true;
                    if (inp.checked !== targetValue) {
                        inp.click();
                        if (inp.checked !== targetValue) {
                            inp.checked = targetValue;
                            inp.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    }
                } else {
                    inp.select();
                    // Attempt to use execCommand for better React state sync
                    try {
                        document.execCommand('insertText', false, val);
                    } catch(e) { console.error("execCommand failed", e); }
                    
                    if (inp.value !== val) {
                        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
                        nativeInputValueSetter.call(inp, val);
                    }
                    
                    inp.dispatchEvent(new Event('input', { bubbles: true }));
                    inp.dispatchEvent(new Event('change', { bubbles: true }));
                }
                inp.blur();
                await new Promise(r => setTimeout(r, 50)); // Tiny delay between inputs
            }
        }
    }


    // Capture current value as "stale" before we click OK
    globalStaleValue = normalizeValue(getCurrentProfitValue());
    hasSeenLoadingTransition = false;
    console.log(`TV Optimizer: Current (stale) value normalized: "${globalStaleValue}". Applying settings...`);

    // Apply and ensure we switch to Overview
    const activeModal = document.querySelector('div[data-name="indicator-properties-dialog"]');
    if (activeModal) {
        let targetBtn = activeModal.querySelector('[data-name="submit"]');
        if (!targetBtn) {
            targetBtn = Array.from(activeModal.querySelectorAll('button')).find(btn => btn.innerText.trim() === 'OK');
        }
        if (targetBtn) {
            targetBtn.click();
            console.log("TV Optimizer: Clicked OK. Waiting for modal to close...");
            
            // Phase 0: Wait for modal to actually close
            let modalStillExists = true;
            for (let i = 0; i < 15; i++) {
                await new Promise(r => setTimeout(r, 200));
                if (!document.querySelector('div[data-name="indicator-properties-dialog"]')) {
                    modalStillExists = false;
                    break;
                }
            }
            if (modalStillExists) console.warn("TV Optimizer: Modal didn't close after 3s, proceeding anyway...");
            else console.log("TV Optimizer: Modal confirmed closed.");
        }
    }

    // Phase 1: Mandatory Settling (Give TV time to start calculating)
    console.log("TV Optimizer: Settling for 1.5s to allow calculation to start...");
    await new Promise(r => setTimeout(r, 1500));
    
    await ensureOverviewTabActive();
    waitForCalculationAndScrape();
}


async function waitForCalculationAndScrape() {
    console.log("TV Optimizer: Waiting for numbers (Tab-Force Mode)...");
    
    currentPollCount = 0;
    const maxPolls = 100; // Increased to 50s total

    
    return new Promise((resolve) => {
        const pollTimer = setInterval(async () => {
            // Re-ensure tab is active during long calculations
            if (currentPollCount % 10 === 0) await ensureOverviewTabActive();

            if (isDataLoadedByAlignment() || currentPollCount >= maxPolls) {
                if (currentPollCount >= maxPolls) {
                    console.warn("TV Optimizer: Reached max polls. Scraping whatever is available.");
                } else {
                    console.log(`TV Optimizer: New data detected after ${currentPollCount * 0.5}s. Final stabilization wait...`);
                }

                clearInterval(pollTimer);
                
                setTimeout(() => {
                    scrapeMetrics();
                    resolve();
                }, 1000); // 1s final buffer
            }
            currentPollCount++;
        }, 500);
    });
}

function getCurrentProfitValue() {
    const labelEl = findLabelElement("Total P&L") || findLabelElement("Net Profit");
    if (!labelEl) return "N/A";
    return extractValueBySmartPair(labelEl, "Net Profit");
}

function normalizeValue(val) {
    if (!val || val === "N/A" || val === "---") return val;
    // Keep only numbers, dot, and minus (handles commas, currency signs, etc.)
    return val.replace(/−/g, '-').replace(/[^\d.-]/g, '');
}

function isDataLoadedByAlignment() {
    const rawVal = getCurrentProfitValue();
    const valStr = normalizeValue(rawVal);
    
    // Status check
    if (rawVal === "N/A" || rawVal.includes('---')) {
        if (!hasSeenLoadingTransition) {
            hasSeenLoadingTransition = true;
            console.log("TV Optimizer: Loading state detected ('---').");
        }
        return false;
    }

    const isNumeric = /[0-9]/.test(valStr);
    if (!isNumeric) return false;

    // Case 1: We saw a loading transition and now we have a number
    if (hasSeenLoadingTransition) {
        console.log(`TV Optimizer: New data loaded (after loading state): "${valStr}"`);
        return true;
    }

    // Case 2: The value is different from the normalized stale value.
    if (globalStaleValue && valStr !== globalStaleValue && valStr !== "0") {
        console.log(`TV Optimizer: Detected value change from "${globalStaleValue}" to "${valStr}".`);
        return true;
    }

    // Case 3: Safety fallback - if it's been more than 6 seconds and we have a stable number
    if (currentPollCount > 12) { 
        console.log(`TV Optimizer: Value stable at "${valStr}" after delay. Assuming valid.`);
        return true;
    }

    return false;
}

async function ensureInputsTabActive(modal) {
    const tabs = Array.from(modal.querySelectorAll('[class*="tab"], [role="tab"]'));
    const inputsTab = tabs.find(t => t.innerText.trim().toLowerCase() === 'inputs' || t.getAttribute('data-name') === 'inputs');
    
    if (inputsTab) {
        const isActive = inputsTab.className.includes('active') || inputsTab.getAttribute('aria-selected') === 'true';
        if (!isActive) {
            inputsTab.click();
            console.log("TV Optimizer: Switched to Inputs tab.");
            await new Promise(r => setTimeout(r, 500));
        }
    }
}


async function ensureOverviewTabActive() {
    console.log("TV Optimizer: Ensuring Metrics/Overview tab is active...");
    
    // Pierce shadows to find tab buttons
    const tabs = findAllInShadows('button, div[role="tab"]');
    
    const targetTab = tabs.find(t => {
        const txt = t.innerText.trim().toLowerCase();
        return txt === 'metrics' || txt === 'overview' || txt === 'performance summary';
    });

    if (targetTab) {
        const isActive = targetTab.className.includes('active') || targetTab.className.includes('selected') || targetTab.getAttribute('aria-selected') === 'true';
        if (!isActive) {
            targetTab.click();
            console.log(`TV Optimizer: Clicked "${targetTab.innerText.trim()}" tab.`);
            await new Promise(r => setTimeout(r, 800));
        }
    }
}

function findAllInShadows(selector, root = document) {
    let elements = Array.from(root.querySelectorAll(selector));
    
    // Find all elements that might have a shadow root
    const all = root.querySelectorAll('*');
    for (const el of all) {
        if (el.shadowRoot) {
            elements = elements.concat(findAllInShadows(selector, el.shadowRoot));
        }
    }
    return elements;
}

function findLabelElement(text) {
    const searchTerm = text.toLowerCase();
    const all = findAllInShadows('div, span, td, th, .tv-control-label');
    
    const matches = Array.from(all).filter(el => {
        const t = (el.innerText || el.textContent || "").trim().toLowerCase();
        // Check if the exact text or a common variant is present
        const isMatch = t === searchTerm || t === `${searchTerm}:` || t.includes(searchTerm);
        if (!isMatch) return false;

        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });

    if (matches.length > 0) {
        const bestMatch = matches.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0];
        
        // Visual indicator
        const oldBg = bestMatch.style.backgroundColor;
        bestMatch.style.backgroundColor = 'rgba(255, 255, 0, 0.5)';
        setTimeout(() => { bestMatch.style.backgroundColor = oldBg; }, 300);

        return bestMatch;
    }
    return null;
}

function extractValueBySmartPair(labelEl, metricType, wantPercentage = false) {
    if (!labelEl) return "N/A";

    const labelRect = labelEl.getBoundingClientRect();
    const labelCenterX = (labelRect.left + labelRect.right) / 2;
    const labelCenterY = (labelRect.top + labelRect.bottom) / 2;
    
    const all = findAllInShadows('div, span, td');
    
    // Step 1: Broad Filter (Acceptance Zone)
    const candidates = all.filter(el => {
        if (el === labelEl || !el.innerText.trim() || el.querySelectorAll('*').length > 2) return false;
        
        const rect = el.getBoundingClientRect();
        const elCenterX = (rect.left + rect.right) / 2;
        const elCenterY = (rect.top + rect.bottom) / 2;
        
        const isRight = Math.abs(elCenterY - labelCenterY) < 18 && rect.left >= labelRect.left - 5 && rect.left < labelRect.left + 220;
        // Expanded horizontal lane to 150px to capture right-aligned percentage siblings
        const isBelow = Math.abs(elCenterX - labelCenterX) < 150 && rect.top >= labelRect.top - 5 && rect.top < labelRect.bottom + 120;

        return (isRight || isBelow) && rect.width > 0;
    }).map(el => {
        const rect = el.getBoundingClientRect();
        const dist = Math.hypot((rect.left + rect.right)/2 - labelCenterX, (rect.top + rect.bottom)/2 - labelCenterY);
        return { el, text: el.innerText.trim(), dist };
    }).sort((a, b) => a.dist - b.dist);

    // Step 2: Intelligent Filter based on Type
    const numericNeighbors = candidates.filter(c => /[0-9]/.test(c.text) && !c.text.includes('---')).slice(0, 4);

    if (wantPercentage) {
        // Priority 1: A neighbor that explicitly contains '%'
        const pctNeighbor = numericNeighbors.find(c => c.text.includes('%'));
        if (pctNeighbor) {
            flashElement(pctNeighbor.el, 'rgba(0, 255, 100, 0.5)'); // Bright green for %
            return pctNeighbor.text;
        }
    } else {
        // Priority 1: A neighbor that DOES NOT contain '%' (likely the monetary amount)
        const amountNeighbor = numericNeighbors.find(c => !c.text.includes('%'));
        if (amountNeighbor) {
            flashElement(amountNeighbor.el, 'rgba(0, 255, 0, 0.4)'); // Normal green for Currency
            return amountNeighbor.text;
        }
    }

    // Fallback: Just return the closest one
    if (numericNeighbors.length > 0) {
        flashElement(numericNeighbors[0].el, 'rgba(0, 255, 0, 0.2)');
        return numericNeighbors[0].text;
    }

    return "N/A";
}

function flashElement(el, color) {
    const oldBg = el.style.backgroundColor;
    el.style.backgroundColor = color;
    setTimeout(() => { el.style.backgroundColor = oldBg; }, 600);
}

function cleanVisualMetricValue(val, type = "currency") {
    if (!val) return "N/A";
    
    // Normalize Unicode minus and remove commas/extra whitespace
    let normalized = val.replace(/−/g, '-').replace(/,/g, '').trim();
    
    if (type === "percent") {
        // Look for any number followed by a % sign anywhere in the string
        const pctRegex = /(-?\d+(\.\d+)?)\s*%/g;
        let matches = [];
        let m;
        while ((m = pctRegex.exec(normalized)) !== null) {
            matches.push(m[1]);
        }
        
        if (matches.length > 0) {
            // Usually the last % in the string is the one we want
            return matches[matches.length - 1];
        }

        const fallback = normalized.match(/(-?\d+(\.\d+)?)/);
        return fallback ? fallback[0] : "N/A";
    }

    // Default: Currency/Amount extraction (typically the first number in the string)
    const amountMatch = normalized.match(/(-?\d+(\.\d+)?)/);
    if (amountMatch) {
        return amountMatch[0];
    }

    return "N/A";
}



function scrapeMetrics() {
    const labelMaps = {
        "Net Profit": ["Total P&L", "Net Profit"],
        "Net Profit (%)": ["Total P&L", "Net Profit"],
        "Max Drawdown": ["Max equity drawdown", "Max Drawdown"],
        "Max Drawdown (%)": ["Max equity drawdown", "Max Drawdown"],
        "Profit Factor": ["Profit factor", "Profit Factor"],
        "Percent Profitable": ["Profitable trades", "Percent Profitable"]
    };

    const results = {};
    console.log("TV Optimizer: Starting Full Metric Scrape...");

    for (const [key, variants] of Object.entries(labelMaps)) {
        let foundVal = "N/A";
        for (const variant of variants) {
            const el = findLabelElement(variant);
            if (el) {
                // Determine if we want percentage or currency
                const wantPct = key.includes("(%)") || key === "Percent Profitable";
                
                // Get RAW text from the pairer (now with sibling detection)
                const rawText = extractValueBySmartPair(el, key, wantPct);
                
                // Final clean based on type
                foundVal = cleanVisualMetricValue(rawText, wantPct ? "percent" : "currency");
                
                if (foundVal !== "N/A" && foundVal !== "---") break;
            }
        }
        results[key] = foundVal;
        console.log(`Scraped ${key}: ${foundVal}`);
    }

    chrome.runtime.sendMessage({ action: "permutation_result", data: results });
}





