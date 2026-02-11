/**
 * DCTL Parameter Controls
 *
 * Shared module for creating DCTL parameter UI controls.
 * Used by both Analysis Viewer and EXR Viewer.
 */

// ============================================
// Types
// ============================================

export interface DctlSliderParam {
    name: string;
    label: string;
    type: 'DCTL_SLIDER_FLOAT' | 'DCTL_SLIDER_INT';
    default: number;
    min: number;
    max: number;
    step: number;
}

export interface DctlValueBoxParam {
    name: string;
    label: string;
    type: 'DCTL_VALUE_BOX';
    default: number;
}

export interface DctlCheckBoxParam {
    name: string;
    label: string;
    type: 'DCTL_CHECK_BOX';
    default: boolean;
}

export interface DctlComboBoxParam {
    name: string;
    label: string;
    type: 'DCTL_COMBO_BOX';
    default: number;
    options: string[];
}

export interface DctlColorValue {
    r: number;
    g: number;
    b: number;
}

export interface DctlColorPickerParam {
    name: string;
    label: string;
    type: 'DCTL_COLOR_PICKER';
    default: DctlColorValue;
}

export type DctlParam =
    | DctlSliderParam
    | DctlValueBoxParam
    | DctlCheckBoxParam
    | DctlComboBoxParam
    | DctlColorPickerParam;

export type DctlParamValue = number | boolean | DctlColorValue;

// ============================================
// DCTL Controls Manager
// ============================================

export interface DctlControlsOptions {
    /** Container element to render controls into */
    container: HTMLElement;
    /** Callback when a parameter value changes */
    onChange: (name: string, value: DctlParamValue) => void;
    /** Empty state message */
    emptyMessage?: string;
    /** Optional logger function for unified logging */
    log?: (message: string) => void;
}

export interface DctlControlsManager {
    /** Build controls for the given parameters */
    build(params: DctlParam[]): void;
    /** Clear all controls */
    clear(): void;
    /** Get current value of a parameter */
    getValue(name: string): DctlParamValue | undefined;
    /** Get all current values */
    getValues(): Record<string, DctlParamValue>;
}

/**
 * Create a DCTL controls manager
 */
export function createDctlControlsManager(options: DctlControlsOptions): DctlControlsManager {
    const { container, onChange, emptyMessage = 'No parameters', log } = options;
    const values: Record<string, DctlParamValue> = {};

    // Internal logger that uses provided log function or falls back to console.log
    function logMessage(message: string): void {
        if (log) {
            log(`[DCTL Controls] ${message}`);
        } else {
            console.log(`[DCTL Controls] ${message}`);
        }
    }

    function onParamChange(name: string, value: DctlParamValue): void {
        logMessage(`onParamChange: ${name} = ${JSON.stringify(value)}`);
        values[name] = value;
        onChange(name, value);
    }

    function build(params: DctlParam[]): void {
        container.innerHTML = '';
        Object.keys(values).forEach((key) => delete values[key]);

        if (params.length === 0) {
            container.innerHTML = `<span class="dctl-params-empty">${emptyMessage}</span>`;
            return;
        }

        for (const param of params) {
            values[param.name] = param.default;
            const control = createParamControl(param, onParamChange);
            if (control) {
                container.appendChild(control);
            }
        }
    }

    function clear(): void {
        container.innerHTML = `<span class="dctl-params-empty">${emptyMessage}</span>`;
        Object.keys(values).forEach((key) => delete values[key]);
    }

    return {
        build,
        clear,
        getValue: (name) => values[name],
        getValues: () => ({ ...values }),
    };
}

// ============================================
// Control Creation Functions
// ============================================

function createParamControl(
    param: DctlParam,
    onChange: (name: string, value: DctlParamValue) => void
): HTMLElement | null {
    switch (param.type) {
        case 'DCTL_SLIDER_FLOAT':
        case 'DCTL_SLIDER_INT':
            return createSliderControl(param, onChange);
        case 'DCTL_VALUE_BOX':
            return createValueBoxControl(param, onChange);
        case 'DCTL_CHECK_BOX':
            return createCheckboxControl(param, onChange);
        case 'DCTL_COMBO_BOX':
            return createComboBoxControl(param, onChange);
        case 'DCTL_COLOR_PICKER':
            return createColorPickerControl(param, onChange);
        default:
            console.warn(`Unknown DCTL param type: ${(param as DctlParam).type}`);
            return null;
    }
}

function createSliderControl(
    param: DctlSliderParam,
    onChange: (name: string, value: number) => void
): HTMLElement {
    const container = document.createElement('div');
    container.className = 'dctl-param dctl-slider';

    const step = param.step;
    const precision = Math.max(0, -Math.floor(Math.log10(step)));
    const isInt = param.type === 'DCTL_SLIDER_INT';

    const row = document.createElement('div');
    row.className = 'dctl-param-row';

    const label = document.createElement('span');
    label.className = 'dctl-param-label';
    label.textContent = param.label;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(param.min);
    slider.max = String(param.max);
    slider.step = String(step);
    slider.value = String(param.default);

    const numberInput = document.createElement('input');
    numberInput.type = 'number';
    numberInput.min = String(param.min);
    numberInput.max = String(param.max);
    numberInput.step = String(step);
    numberInput.value = isInt ? String(Math.round(param.default)) : param.default.toFixed(precision);

    const resetBtn = createResetButton(() => {
        const value = param.default;
        slider.value = String(value);
        numberInput.value = isInt ? String(Math.round(value)) : value.toFixed(precision);
        onChange(param.name, value);
    });

    slider.addEventListener('input', () => {
        const value = isInt ? parseInt(slider.value, 10) : parseFloat(slider.value);
        numberInput.value = isInt ? String(value) : value.toFixed(precision);
        onChange(param.name, value);
    });

    numberInput.addEventListener('input', () => {
        let value = isInt ? parseInt(numberInput.value, 10) : parseFloat(numberInput.value);
        if (isNaN(value)) value = param.default;
        value = Math.max(param.min, Math.min(param.max, value));
        slider.value = String(value);
        onChange(param.name, value);
    });

    row.appendChild(label);
    row.appendChild(slider);
    row.appendChild(numberInput);
    row.appendChild(resetBtn);
    container.appendChild(row);

    return container;
}

function createValueBoxControl(
    param: DctlValueBoxParam,
    onChange: (name: string, value: number) => void
): HTMLElement {
    const container = document.createElement('div');
    container.className = 'dctl-param dctl-valuebox';

    const row = document.createElement('div');
    row.className = 'dctl-param-row';

    const label = document.createElement('span');
    label.className = 'dctl-param-label';
    label.textContent = param.label;

    const numberInput = document.createElement('input');
    numberInput.type = 'number';
    numberInput.step = 'any';
    numberInput.value = String(param.default);

    const resetBtn = createResetButton(() => {
        numberInput.value = String(param.default);
        onChange(param.name, param.default);
    });

    numberInput.addEventListener('input', () => {
        const value = parseFloat(numberInput.value);
        if (!isNaN(value)) {
            onChange(param.name, value);
        }
    });

    row.appendChild(label);
    row.appendChild(numberInput);
    row.appendChild(resetBtn);
    container.appendChild(row);

    return container;
}

function createCheckboxControl(
    param: DctlCheckBoxParam,
    onChange: (name: string, value: boolean) => void
): HTMLElement {
    const container = document.createElement('div');
    container.className = 'dctl-param dctl-checkbox';

    const row = document.createElement('div');
    row.className = 'dctl-param-row';

    const spacer = document.createElement('span');
    spacer.className = 'dctl-param-label';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `dctl-checkbox-${param.name}`;
    checkbox.checked = param.default;

    const label = document.createElement('label');
    label.className = 'dctl-checkbox-label';
    label.htmlFor = checkbox.id;
    label.textContent = param.label;

    const resetBtn = createResetButton(() => {
        checkbox.checked = param.default;
        onChange(param.name, param.default);
    });

    checkbox.addEventListener('change', () => {
        onChange(param.name, checkbox.checked);
    });

    row.appendChild(spacer);
    row.appendChild(checkbox);
    row.appendChild(label);
    row.appendChild(resetBtn);
    container.appendChild(row);

    return container;
}

function createComboBoxControl(
    param: DctlComboBoxParam,
    onChange: (name: string, value: number) => void
): HTMLElement {
    const container = document.createElement('div');
    container.className = 'dctl-param dctl-combobox';

    const row = document.createElement('div');
    row.className = 'dctl-param-row';

    const label = document.createElement('span');
    label.className = 'dctl-param-label';
    label.textContent = param.label;

    const select = document.createElement('select');
    for (let i = 0; i < param.options.length; i++) {
        const option = document.createElement('option');
        option.value = String(i);
        option.textContent = param.options[i];
        select.appendChild(option);
    }
    select.value = String(param.default);

    const resetBtn = createResetButton(() => {
        select.value = String(param.default);
        onChange(param.name, param.default);
    });

    select.addEventListener('change', () => {
        onChange(param.name, parseInt(select.value, 10));
    });

    row.appendChild(label);
    row.appendChild(select);
    row.appendChild(resetBtn);
    container.appendChild(row);

    return container;
}

function createColorPickerControl(
    param: DctlColorPickerParam,
    onChange: (name: string, value: DctlColorValue) => void
): HTMLElement {
    const container = document.createElement('div');
    container.className = 'dctl-param dctl-colorpicker';

    const row = document.createElement('div');
    row.className = 'dctl-param-row';

    const label = document.createElement('span');
    label.className = 'dctl-param-label';
    label.textContent = param.label;

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = rgbToHex(param.default);

    const rgbInputs = document.createElement('div');
    rgbInputs.className = 'dctl-rgb-inputs';

    const rInput = document.createElement('input');
    rInput.type = 'number';
    rInput.min = '0';
    rInput.max = '1';
    rInput.step = '0.01';
    rInput.value = param.default.r.toFixed(3);
    rInput.placeholder = 'R';

    const gInput = document.createElement('input');
    gInput.type = 'number';
    gInput.min = '0';
    gInput.max = '1';
    gInput.step = '0.01';
    gInput.value = param.default.g.toFixed(3);
    gInput.placeholder = 'G';

    const bInput = document.createElement('input');
    bInput.type = 'number';
    bInput.min = '0';
    bInput.max = '1';
    bInput.step = '0.01';
    bInput.value = param.default.b.toFixed(3);
    bInput.placeholder = 'B';

    const resetBtn = createResetButton(() => {
        const def = param.default;
        colorInput.value = rgbToHex(def);
        rInput.value = def.r.toFixed(3);
        gInput.value = def.g.toFixed(3);
        bInput.value = def.b.toFixed(3);
        onChange(param.name, def);
    });

    colorInput.addEventListener('input', () => {
        const rgb = hexToRgb(colorInput.value);
        rInput.value = rgb.r.toFixed(3);
        gInput.value = rgb.g.toFixed(3);
        bInput.value = rgb.b.toFixed(3);
        onChange(param.name, rgb);
    });

    const onRgbChange = () => {
        const rgb: DctlColorValue = {
            r: Math.max(0, Math.min(1, parseFloat(rInput.value) || 0)),
            g: Math.max(0, Math.min(1, parseFloat(gInput.value) || 0)),
            b: Math.max(0, Math.min(1, parseFloat(bInput.value) || 0)),
        };
        colorInput.value = rgbToHex(rgb);
        onChange(param.name, rgb);
    };

    rInput.addEventListener('input', onRgbChange);
    gInput.addEventListener('input', onRgbChange);
    bInput.addEventListener('input', onRgbChange);

    rgbInputs.appendChild(rInput);
    rgbInputs.appendChild(gInput);
    rgbInputs.appendChild(bInput);

    row.appendChild(label);
    row.appendChild(colorInput);
    row.appendChild(rgbInputs);
    row.appendChild(resetBtn);
    container.appendChild(row);

    return container;
}

// ============================================
// Helper Functions
// ============================================

function createResetButton(onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'dctl-reset-btn';
    btn.title = 'Reset';
    btn.innerHTML = '&#8634;'; // ↺
    btn.addEventListener('click', onClick);
    return btn;
}

/**
 * Convert linear RGB (0-1) to hex color string
 */
export function rgbToHex(rgb: DctlColorValue): string {
    const toSrgb = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
    const r = Math.round(Math.max(0, Math.min(255, toSrgb(rgb.r) * 255)));
    const g = Math.round(Math.max(0, Math.min(255, toSrgb(rgb.g) * 255)));
    const b = Math.round(Math.max(0, Math.min(255, toSrgb(rgb.b) * 255)));
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Convert hex color string to linear RGB (0-1)
 */
export function hexToRgb(hex: string): DctlColorValue {
    const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return {
        r: toLinear(r),
        g: toLinear(g),
        b: toLinear(b),
    };
}
