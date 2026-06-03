'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const { create, all } = require('mathjs');
const {
  DebugLogger,
  DEBUG_CID_SETTING_KEY,
  DEBUG_ENABLED_SETTING_KEY,
  generateDebugCid,
} = require('./lib/debug_logger');

const math = create(all, {});

const UNIT_GROUPS = {
  length: [
    ['mm', 'millimeter', 'millimeter'],
    ['cm', 'centimeter', 'centimeter'],
    ['m', 'meter', 'meter'],
    ['km', 'kilometer', 'kilometer'],
    ['in', 'inch', 'inch'],
    ['ft', 'foot', 'voet'],
    ['yd', 'yard', 'yard'],
    ['mi', 'mile', 'mijl'],
  ],
  mass: [
    ['mg', 'milligram', 'milligram'],
    ['g', 'gram', 'gram'],
    ['kg', 'kilogram', 'kilogram'],
    ['oz', 'ounce', 'ounce'],
    ['lb', 'pound', 'pond'],
  ],
  volume: [
    ['ml', 'milliliter', 'milliliter'],
    ['l', 'liter', 'liter'],
    ['m3', 'cubic meter', 'kubieke meter'],
    ['tsp', 'teaspoon', 'theelepel'],
    ['tbsp', 'tablespoon', 'eetlepel'],
  ],
  time: [
    ['s', 'second', 'seconde'],
    ['min', 'minute', 'minuut'],
    ['h', 'hour', 'uur'],
    ['day', 'day', 'dag'],
  ],
  temperature: [
    ['degC', 'Celsius', 'Celsius'],
    ['degF', 'Fahrenheit', 'Fahrenheit'],
    ['K', 'Kelvin', 'Kelvin'],
  ],
  speed: [
    ['m/s', 'meters per second', 'meter per seconde'],
    ['km/h', 'kilometers per hour', 'kilometer per uur'],
    ['mph', 'miles per hour', 'mijl per uur'],
  ],
  angle: [
    ['rad', 'radian', 'radialen'],
    ['deg', 'degree', 'graden'],
  ],
  power: [
    ['W', 'watt', 'watt'],
    ['kW', 'kilowatt', 'kilowatt'],
  ],
  energy: [
    ['Wh', 'watt hour', 'wattuur'],
    ['kWh', 'kilowatt hour', 'kilowattuur'],
  ],
  pressure: [
    ['Pa', 'pascal', 'pascal'],
    ['bar', 'bar', 'bar'],
  ],
};

const UNIT_INDEX = Object.entries(UNIT_GROUPS).reduce((index, [groupId, units]) => {
  for (const [id, englishLabel, dutchLabel] of units) {
    index[id] = { groupId, id, englishLabel, dutchLabel };
  }
  return index;
}, {});

module.exports = class ByLutoMathApp extends Homey.App {

  async onInit() {
    this._ensureDebugCid();
    this.debugLogger = new DebugLogger(this.homey, this.log.bind(this), this.error.bind(this));
    this.homey.settings.on('set', this._onSettingSet.bind(this));
    this.homeyApi = await HomeyAPI.createAppAPI({ homey: this.homey });

    this._registerAutocompleteCards();
    this._registerActionCards();
    this._registerConditionCards();

    this.debugLog('app', 'Math app initialized', {
      homeyVersion: this.homey.version,
      platform: this.homey.platform,
      platformVersion: this.homey.platformVersion,
    });
  }

  _ensureDebugCid() {
    const currentCid = this.homey.settings.get(DEBUG_CID_SETTING_KEY);
    if (typeof currentCid === 'string' && currentCid.trim() !== '') {
      return;
    }

    this.homey.settings.set(DEBUG_CID_SETTING_KEY, generateDebugCid());
  }

  _onSettingSet(key) {
    if (!this.debugLogger) {
      return;
    }

    if (key === DEBUG_CID_SETTING_KEY) {
      this.debugLogger.capture('info', 'settings', [{
        message: 'Debug CID updated',
        cid: this.homey.settings.get(DEBUG_CID_SETTING_KEY),
      }], true);
      return;
    }

    if (key === DEBUG_ENABLED_SETTING_KEY) {
      this.debugLogger.capture('info', 'settings', [{
        message: 'Debug setting changed',
        enabled: this.homey.settings.get(DEBUG_ENABLED_SETTING_KEY) === true,
        cid: this.homey.settings.get(DEBUG_CID_SETTING_KEY),
      }], true);
    }
  }

  forwardDebug(level, source, ...args) {
    if (!this.debugLogger) {
      return;
    }

    this.debugLogger.capture(level, source, args);
  }

  debugLog(source, ...args) {
    this.log(...args);
    this.forwardDebug('info', source, ...args);
  }

  debugError(source, ...args) {
    this.error(...args);
    this.forwardDebug('error', source, ...args);
  }

  _registerAutocompleteCards() {
    const cardIds = [
      'modify_variable',
      'calculate_to_variable',
      'function_to_variable',
      'convert_unit_to_variable',
      'evaluate_expression_to_variable',
      'get_variable_value',
    ];

    for (const cardId of cardIds) {
      const card = this.homey.flow.getActionCard(cardId);
      card.registerArgumentAutocompleteListener('variable', async (query) => this._autocompleteNumberVariables(query));
    }

    for (const cardId of ['convert_unit', 'convert_unit_to_variable']) {
      const card = this.homey.flow.getActionCard(cardId);
      card.registerArgumentAutocompleteListener('to_unit', async (query, args) => this._autocompleteTargetUnits(query, args));
    }
  }

  _registerActionCards() {
    this.homey.flow.getActionCard('get_variable_value')
      .registerRunListener(async (args) => {
        const variable = await this._resolveVariable(args.variable);
        const result = this._assertFiniteNumber(variable.value, 'Current variable value');
        this.debugLog('flow:get_variable_value', 'Variable value retrieved', {
          variableId: variable.id,
          variableName: variable.name,
          result,
        });
        return { result };
      });

    this.homey.flow.getActionCard('modify_variable')
      .registerRunListener(async (args) => {
        const variable = await this._resolveVariable(args.variable);
        const current = this._assertFiniteNumber(variable.value, 'Current variable value');
        const operand = this._evaluateNumber(args.value, { current });
        const result = this._applyNumericOperator(current, args.operator, operand);
        await this._updateVariable(variable, result, 'modify_variable', {
          operator: args.operator,
          operand,
          previousValue: current,
        });
      });

    this.homey.flow.getActionCard('calculate_to_variable')
      .registerRunListener(async (args) => {
        const variable = await this._resolveVariable(args.variable);
        const left = this._evaluateNumber(args.left);
        const right = this._evaluateNumber(args.right);
        const result = this._applyNumericOperator(left, args.operator, right);
        await this._updateVariable(variable, result, 'calculate_to_variable', {
          left,
          operator: args.operator,
          right,
        });
      });

    this.homey.flow.getActionCard('function_to_variable')
      .registerRunListener(async (args) => {
        const variable = await this._resolveVariable(args.variable);
        const current = this._assertFiniteNumber(variable.value, 'Current variable value');
        const values = this._evaluateOptionalValues(args, { current });
        const result = this._applyFunction(args.function, values);
        await this._updateVariable(variable, result, 'function_to_variable', {
          function: args.function,
          values,
        });
      });

    this.homey.flow.getActionCard('convert_unit_to_variable')
      .registerRunListener(async (args) => {
        const variable = await this._resolveVariable(args.variable);
        const result = this._convertUnit(args.value, args.from_unit, args.to_unit);
        await this._updateVariable(variable, result, 'convert_unit_to_variable', {
          value: args.value,
          fromUnit: this._normalizeUnitArgument(args.from_unit),
          toUnit: this._normalizeUnitArgument(args.to_unit),
        });
      });

    this.homey.flow.getActionCard('evaluate_expression_to_variable')
      .registerRunListener(async (args) => {
        const variable = await this._resolveVariable(args.variable);
        const current = this._assertFiniteNumber(variable.value, 'Current variable value');
        const result = this._evaluateNumber(args.expression, { current });
        await this._updateVariable(variable, result, 'evaluate_expression_to_variable', {
          expression: args.expression,
          current,
        });
      });

    this.homey.flow.getActionCard('calculate')
      .registerRunListener(async (args) => {
        const left = this._evaluateNumber(args.left);
        const right = this._evaluateNumber(args.right);
        const result = this._applyNumericOperator(left, args.operator, right);
        this.debugLog('flow:calculate', 'Advanced calculate executed', {
          left,
          operator: args.operator,
          right,
          result,
        });
        return { result };
      });

    this.homey.flow.getActionCard('apply_function')
      .registerRunListener(async (args) => {
        const values = this._evaluateOptionalValues(args);
        const result = this._applyFunction(args.function, values);
        this.debugLog('flow:apply_function', 'Advanced function executed', {
          function: args.function,
          values,
          result,
        });
        return { result };
      });

    this.homey.flow.getActionCard('apply_function_values')
      .registerRunListener(async (args) => {
        const values = this._evaluateFunctionValuesList(args.values);
        const result = this._applyFunction(args.function, values);
        this.debugLog('flow:apply_function_values', 'Advanced function list executed', {
          function: args.function,
          values,
          result,
        });
        return { result };
      });

    this.homey.flow.getActionCard('evaluate_expression')
      .registerRunListener(async (args) => {
        const result = this._evaluateNumber(args.expression);
        this.debugLog('flow:evaluate_expression', 'Advanced expression executed', {
          expression: args.expression,
          result,
        });
        return { result };
      });

    this.homey.flow.getActionCard('convert_unit')
      .registerRunListener(async (args) => {
        const result = this._convertUnit(args.value, args.from_unit, args.to_unit);
        this.debugLog('flow:convert_unit', 'Advanced unit conversion executed', {
          value: args.value,
          fromUnit: this._normalizeUnitArgument(args.from_unit),
          toUnit: this._normalizeUnitArgument(args.to_unit),
          result,
        });
        return { result };
      });
  }

  _registerConditionCards() {
    this.homey.flow.getConditionCard('compare_values')
      .registerRunListener(async (args) => {
        const left = this._evaluateNumber(args.left);
        const right = this._evaluateNumber(args.right);
        const result = this._compareNumbers(left, args.operator, right);
        this.debugLog('condition:compare_values', 'Compare values evaluated', {
          left,
          operator: args.operator,
          right,
          result,
        });
        return result;
      });

    this.homey.flow.getConditionCard('boolean_logic')
      .registerRunListener(async (args) => {
        const left = this._evaluateBoolean(args.left);
        const right = args.operator === 'not' ? false : this._evaluateBoolean(args.right);
        const result = this._applyBooleanOperator(left, args.operator, right);
        this.debugLog('condition:boolean_logic', 'Boolean logic evaluated', {
          left,
          operator: args.operator,
          right,
          result,
        });
        return result;
      });

    this.homey.flow.getConditionCard('is_empty')
      .registerRunListener(async (args) => {
        const result = this._isEmpty(args.value);
        this.debugLog('condition:is_empty', 'Empty check evaluated', {
          value: args.value,
          result,
        });
        return result;
      });

    this.homey.flow.getConditionCard('contains_value')
      .registerRunListener(async (args) => {
        const haystack = args.haystack === undefined || args.haystack === null ? '' : String(args.haystack);
        const needle = args.needle === undefined || args.needle === null ? '' : String(args.needle);
        const result = haystack.includes(needle);
        this.debugLog('condition:contains_value', 'Contains check evaluated', {
          haystack,
          needle,
          result,
        });
        return result;
      });

    this.homey.flow.getConditionCard('expression_is_true')
      .registerRunListener(async (args) => {
        const result = this._evaluateBoolean(args.expression);
        this.debugLog('condition:expression_is_true', 'Boolean expression evaluated', {
          expression: args.expression,
          result,
        });
        return result;
      });
  }

  async _autocompleteNumberVariables(query) {
    const normalizedQuery = String(query || '').trim().toLowerCase();
    const variables = await this._getNumberVariables();
    return variables
      .filter((variable) => {
        if (!normalizedQuery) {
          return true;
        }

        const haystack = `${variable.name} ${variable.id}`.toLowerCase();
        return haystack.includes(normalizedQuery);
      })
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((variable) => ({
        id: variable.id,
        name: variable.name,
        type: variable.type,
        value: variable.value,
        description: `${variable.name} = ${variable.value}`,
      }));
  }

  async _autocompleteTargetUnits(query, args) {
    const normalizedQuery = String(query || '').trim().toLowerCase();
    const sourceUnitId = this._normalizeUnitArgument(args && args.from_unit);
    const compatibleUnits = this._getCompatibleTargetUnits(sourceUnitId, args && args.value);

    return compatibleUnits
      .filter((unit) => {
        if (!normalizedQuery) {
          return true;
        }

        return unit.name.toLowerCase().includes(normalizedQuery) || unit.id.toLowerCase().includes(normalizedQuery);
      })
      .map((unit) => ({
        id: unit.id,
        name: unit.name,
        description: unit.description,
      }));
  }

  async _getNumberVariables() {
    const variables = await this.homeyApi.logic.getVariables();
    return Object.values(variables).filter((variable) => variable.type === 'number');
  }

  async _resolveVariable(variableArg) {
    const variableId = variableArg && variableArg.id ? variableArg.id : null;
    if (!variableId) {
      throw new Error('No Homey Logic variable selected');
    }

    const variable = await this.homeyApi.logic.getVariable({ id: variableId });
    if (!variable) {
      throw new Error(`Homey Logic variable not found: ${variableId}`);
    }

    if (variable.type !== 'number') {
      throw new Error(`Only number variables are supported, got ${variable.type}`);
    }

    return variable;
  }

  async _updateVariable(variable, nextValue, source, details) {
    const value = this._assertFiniteNumber(nextValue, 'Calculated value');
    await this.homeyApi.logic.updateVariable({
      id: variable.id,
      variable: { value },
    });

    this.debugLog(source, 'Logic variable updated', {
      variableId: variable.id,
      variableName: variable.name,
      previousValue: variable.value,
      nextValue: value,
      details,
    });
  }

  _normalizeUnitArgument(value) {
    if (value && typeof value === 'object') {
      if (typeof value.id === 'string') {
        return value.id;
      }
      if (typeof value.name === 'string') {
        return value.name;
      }
    }

    return String(value || '').trim();
  }

  _getCompatibleTargetUnits(fromUnit, rawValue) {
    const normalizedFromUnit = this._normalizeUnitArgument(fromUnit);
    const groupId = normalizedFromUnit && normalizedFromUnit !== 'auto'
      ? (UNIT_INDEX[normalizedFromUnit] && UNIT_INDEX[normalizedFromUnit].groupId)
      : this._inferUnitGroupFromValue(rawValue);

    const groups = groupId ? [groupId] : Object.keys(UNIT_GROUPS);
    return groups.flatMap((currentGroupId) => {
      const units = UNIT_GROUPS[currentGroupId] || [];
      return units.map(([id, englishLabel, dutchLabel]) => ({
        id,
        name: `${id} - ${englishLabel}`,
        description: `NL: ${dutchLabel}`,
      }));
    });
  }

  _inferUnitGroupFromValue(rawValue) {
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
      return null;
    }

    let unitValue;
    try {
      const evaluated = this._evaluateRawValue(rawValue);
      if (evaluated && evaluated.isUnit) {
        unitValue = evaluated;
      } else {
        unitValue = math.unit(String(rawValue));
      }
    } catch (error) {
      return null;
    }

    for (const [groupId, units] of Object.entries(UNIT_GROUPS)) {
      const [candidateUnit] = units[0];
      try {
        unitValue.to(candidateUnit);
        return groupId;
      } catch (error) {
        // Try next group.
      }
    }

    return null;
  }

  _evaluateOptionalValues(args, scope) {
    return ['a', 'b', 'c', 'd', 'e'].map((key) => {
      if (args[key] === undefined || args[key] === null || String(args[key]).trim() === '') {
        return undefined;
      }

      return this._evaluateRawValue(args[key], scope);
    });
  }

  _evaluateFunctionValuesList(input) {
    if (input === undefined || input === null || String(input).trim() === '') {
      throw new Error('At least one value is required');
    }

    const text = String(input).trim();
    const expression = text.startsWith('[') && text.endsWith(']')
      ? text
      : `[${text}]`;

    let result;
    try {
      result = math.evaluate(expression);
    } catch (error) {
      throw new Error(`Could not parse values list "${text}": ${error.message || String(error)}`);
    }

    let values = result;
    if (values && typeof values.toArray === 'function') {
      values = values.toArray();
    }

    if (!Array.isArray(values)) {
      values = [values];
    }

    return values.flat(Infinity);
  }

  _evaluateRawValue(input, scope = {}) {
    if (input === undefined || input === null) {
      throw new Error('Expected a value, received nothing');
    }

    if (typeof input === 'number' || typeof input === 'boolean') {
      return input;
    }

    const text = String(input).trim();
    if (!text) {
      throw new Error('Expected a value, received an empty string');
    }

    try {
      return math.evaluate(text, scope);
    } catch (error) {
      throw new Error(`Could not evaluate "${text}": ${error.message || String(error)}`);
    }
  }

  _evaluateNumber(input, scope = {}) {
    const rawValue = this._evaluateRawValue(input, scope);
    return this._coerceToNumber(rawValue, String(input));
  }

  _evaluateBoolean(input) {
    if (typeof input === 'boolean') {
      return input;
    }

    if (typeof input === 'number') {
      return input !== 0;
    }

    const text = String(input || '').trim();
    if (!text) {
      return false;
    }

    if (/^(true|yes|on)$/i.test(text)) {
      return true;
    }

    if (/^(false|no|off)$/i.test(text)) {
      return false;
    }

    try {
      const result = math.evaluate(text);
      if (typeof result === 'boolean') {
        return result;
      }
      if (typeof result === 'number') {
        return result !== 0;
      }
    } catch (error) {
      // Fall through to a final parse failure.
    }

    throw new Error(`Could not convert "${text}" to boolean`);
  }

  _coerceToNumber(value, original) {
    if (typeof value === 'number') {
      return this._assertFiniteNumber(value, original);
    }

    try {
      const converted = math.number(value);
      return this._assertFiniteNumber(converted, original);
    } catch (error) {
      throw new Error(`Could not convert "${original}" to a number`);
    }
  }

  _assertFiniteNumber(value, label) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      throw new Error(`${label} is not a finite number`);
    }
    return numericValue;
  }

  _applyNumericOperator(left, operator, right) {
    const a = this._assertFiniteNumber(left, 'Left side');
    const b = this._assertFiniteNumber(right, 'Right side');

    switch (operator) {
      case 'set':
        return b;
      case 'add':
        return a + b;
      case 'subtract':
        return a - b;
      case 'multiply':
        return a * b;
      case 'divide':
        if (b === 0) {
          throw new Error('Division by zero is not allowed');
        }
        return a / b;
      case 'modulo':
        if (b === 0) {
          throw new Error('Modulo by zero is not allowed');
        }
        return a % b;
      case 'power':
        return Math.pow(a, b);
      default:
        throw new Error(`Unsupported operator: ${operator}`);
    }
  }

  _applyFunction(functionId, values) {
    const [a, b, c, d, e] = values;

    switch (functionId) {
      case 'abs':
        return this._coerceToNumber(math.abs(a), functionId);
      case 'round':
        return b === undefined
          ? this._coerceToNumber(math.round(a), functionId)
          : this._coerceToNumber(math.round(a, this._coerceToNumber(b, 'round precision')), functionId);
      case 'floor':
        return this._coerceToNumber(math.floor(a), functionId);
      case 'ceil':
        return this._coerceToNumber(math.ceil(a), functionId);
      case 'sqrt':
        return this._coerceToNumber(math.sqrt(a), functionId);
      case 'sin':
        return this._coerceToNumber(math.sin(a), functionId);
      case 'cos':
        return this._coerceToNumber(math.cos(a), functionId);
      case 'tan':
        return this._coerceToNumber(math.tan(a), functionId);
      case 'asin':
        return this._coerceToNumber(math.asin(a), functionId);
      case 'acos':
        return this._coerceToNumber(math.acos(a), functionId);
      case 'atan':
        return this._coerceToNumber(math.atan(a), functionId);
      case 'exp':
        return this._coerceToNumber(math.exp(a), functionId);
      case 'log':
        return this._coerceToNumber(math.log(a), functionId);
      case 'log10':
        return this._coerceToNumber(math.log10(a), functionId);
      case 'min':
        return this._coerceToNumber(math.min(this._requireNumber(a, 'A'), this._requireNumber(b, 'B')), functionId);
      case 'max':
        return this._coerceToNumber(math.max(this._requireNumber(a, 'A'), this._requireNumber(b, 'B')), functionId);
      case 'clamp':
        return this._clamp(
          this._requireNumber(a, 'A'),
          this._requireNumber(b, 'B'),
          this._requireNumber(c, 'C')
        );
      case 'average':
        return (
          this._requireNumber(a, 'A') + this._requireNumber(b, 'B')
        ) / 2;
      case 'percentage':
        return (this._requireNumber(a, 'A') * this._requireNumber(b, 'B')) / 100;
      case 'random':
        return this._randomBetween(this._requireNumber(a, 'A'), this._requireNumber(b, 'B'), false);
      case 'randomInt':
        return this._randomBetween(this._requireNumber(a, 'A'), this._requireNumber(b, 'B'), true);
      case 'mapRange':
        return this._mapRange(
          this._requireNumber(a, 'A'),
          this._requireNumber(b, 'B'),
          this._requireNumber(c, 'C'),
          this._requireNumber(d, 'D'),
          this._requireNumber(e, 'E')
        );
      default:
        throw new Error(`Unsupported function: ${functionId}`);
    }
  }

  _requireNumber(value, label) {
    if (value === undefined) {
      throw new Error(`${label} is required`);
    }

    return this._coerceToNumber(value, label);
  }

  _clamp(value, min, max) {
    if (min > max) {
      throw new Error('Clamp minimum cannot be greater than maximum');
    }

    return Math.min(max, Math.max(min, value));
  }

  _randomBetween(min, max, integerOnly) {
    if (min > max) {
      throw new Error('Random minimum cannot be greater than maximum');
    }

    if (integerOnly) {
      const roundedMin = Math.ceil(min);
      const roundedMax = Math.floor(max);
      if (roundedMin > roundedMax) {
        throw new Error('No integer exists in the requested random range');
      }

      return Math.floor(Math.random() * (roundedMax - roundedMin + 1)) + roundedMin;
    }

    return (Math.random() * (max - min)) + min;
  }

  _mapRange(value, inMin, inMax, outMin, outMax) {
    if (inMin === inMax) {
      throw new Error('Input range cannot be zero');
    }

    const ratio = (value - inMin) / (inMax - inMin);
    return outMin + (ratio * (outMax - outMin));
  }

  _convertUnit(value, fromUnit, toUnit) {
    const normalizedToUnit = this._normalizeUnitArgument(toUnit);
    if (!normalizedToUnit) {
      throw new Error('Target unit is required');
    }

    const normalizedFromUnit = this._normalizeUnitArgument(fromUnit);
    const effectiveFromUnit = normalizedFromUnit === 'auto' ? '' : normalizedFromUnit;
    const rawValue = this._evaluateRawValue(value);

    let unitValue;
    if (effectiveFromUnit) {
      unitValue = math.unit(this._coerceToNumber(rawValue, String(value)), effectiveFromUnit);
    } else if (rawValue && rawValue.isUnit) {
      unitValue = rawValue;
    } else {
      unitValue = math.unit(String(value));
    }

    return unitValue.toNumber(normalizedToUnit);
  }

  _compareNumbers(left, operator, right) {
    switch (operator) {
      case 'eq':
        return left === right;
      case 'ne':
        return left !== right;
      case 'gt':
        return left > right;
      case 'gte':
        return left >= right;
      case 'lt':
        return left < right;
      case 'lte':
        return left <= right;
      default:
        throw new Error(`Unsupported comparison operator: ${operator}`);
    }
  }

  _applyBooleanOperator(left, operator, right) {
    switch (operator) {
      case 'and':
        return left && right;
      case 'or':
        return left || right;
      case 'xor':
        return Boolean(left) !== Boolean(right);
      case 'not':
        return !left;
      default:
        throw new Error(`Unsupported boolean operator: ${operator}`);
    }
  }

  _isEmpty(value) {
    if (value === undefined || value === null) {
      return true;
    }

    if (Array.isArray(value)) {
      return value.length === 0;
    }

    return String(value).trim() === '';
  }
};
