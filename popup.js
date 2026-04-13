document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('scan-btn').addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab.url.includes("tradingview.com")) {
            alert("Please open TradingView!");
            return;
        }

        chrome.tabs.sendMessage(tab.id, { action: "scan" }, (response) => {
            if (response && response.inputs) {
                currentStrategyName = response.strategyName || "Unknown_Strategy";
                renderInputs(response.inputs);
            } else if (response && response.error) {
                alert(response.error);
            } else {
                alert("Failed to scan. Is the Settings dialog open? Injecting might require a page refresh if the extension was just installed.");
            }
        });
    });

    document.getElementById('start-btn').addEventListener('click', () => {
        const permutations = generatePermutations();
        const target = document.getElementById('target-select').value;

        if (permutations.length === 0) {
            alert("No changing inputs to perform optimization.");
            return;
        }
        
        if (permutations.length > 500) {
            if (!confirm(`Warning: You are about to run ${permutations.length} permutations. This might take a while. Continue?`)) {
                return;
            }
        }

        chrome.runtime.sendMessage({
            action: "start_optimization",
            permutations: permutations,
            target: target,
            strategyName: currentStrategyName
        });

        alert(`Optimization started! Running ${permutations.length} iterations. Do not close the TradingView tab.`);
        window.close();
    });
});

let capturedInputs = [];
let currentStrategyName = "Unknown_Strategy";

function renderInputs(inputs) {
    capturedInputs = inputs;
    const container = document.getElementById('inputs-container');
    container.innerHTML = '';

    if (inputs.length === 0) {
        container.innerHTML = "<i>No inputs found.</i>";
        return;
    }

    inputs.forEach((input, index) => {
        const div = document.createElement('div');
        div.className = 'input-row';
        
        const isCheckbox = input.type === 'checkbox';
        
        div.innerHTML = `
            <div class="row-header">
                <label title="${input.label}">${input.label}</label>
                <div class="opt-toggle-container">
                    Opt.
                    <input type="checkbox" id="opt-enable-${index}" class="opt-checkbox">
                </div>
            </div>
            <div id="controls-${index}" class="range-inputs">
                ${isCheckbox ? `
                    <span class="boolean-label">Will test: True & False</span>
                ` : `
                    <input type="number" id="start-${index}" placeholder="Start" value="${input.value}" disabled>
                    <input type="number" id="end-${index}" placeholder="End" value="${input.value}" disabled>
                    <input type="number" id="step-${index}" placeholder="Step" value="0" disabled title="Use 0 for static value">
                `}
            </div>
        `;
        container.appendChild(div);

        // Toggle disabled state based on 'Opt.' checkbox
        const toggle = div.querySelector(`#opt-enable-${index}`);
        toggle.addEventListener('change', (e) => {
            const controls = div.querySelectorAll('input:not(.opt-checkbox)');
            controls.forEach(c => c.disabled = !e.target.checked);
        });
    });

    document.getElementById('optimization-options').style.display = 'block';
}

function generatePermutations() {
    const ranges = capturedInputs.map((input, index) => {
        const isOptimizing = document.getElementById(`opt-enable-${index}`).checked;
        const vals = [];

        if (input.type === 'checkbox') {
            if (isOptimizing) {
                vals.push("true", "false");
            } else {
                vals.push(input.checked.toString()); // Current static state
            }
        } else {
            if (isOptimizing) {
                const start = parseFloat(document.getElementById(`start-${index}`).value);
                const end = parseFloat(document.getElementById(`end-${index}`).value);
                const step = parseFloat(document.getElementById(`step-${index}`).value);

                if (isNaN(start) || isNaN(end) || isNaN(step) || step === 0) {
                    vals.push(input.value); 
                } else {
                    if (start <= end && step > 0) {
                        for (let v = start; v <= end; v += step) vals.push(Number(v.toPrecision(10)).toString());
                    } else if (start >= end && step < 0) {
                        for (let v = start; v >= end; v += step) vals.push(Number(v.toPrecision(10)).toString());
                    } else {
                        vals.push(input.value);
                    }
                }
            } else {
                vals.push(input.value); // Static original value
            }
        }

        return { name: input.name, label: input.label, values: vals, type: input.type };
    });

    // Cartesian product
    const combine = (arr) => {
        if (arr.length === 0) return [{}];
        const result = [];
        const rest = combine(arr.slice(1));
        for (let val of arr[0].values) {
            for (let r of rest) {
                result.push({ ...r, [arr[0].name]: val });
            }
        }
        return result;
    };

    return combine(ranges);
}
