// Safe calculator for Formula fields, shared by the server and the browser.
// Supports numbers, + - * /, parentheses and references to other fields by name: {Qty} * {Price}.
// No eval: expressions are parsed by a tiny recursive-descent parser.
(function (root) {
  function tokenize(expr) {
    const tokens = [];
    const re = /\s*(?:(\d+(?:\.\d+)?)|\{([^}]{1,80})\}|([-+*/()]))/y;
    let m;
    let pos = 0;
    expr = String(expr || '');
    while (pos < expr.length) {
      if (/^\s*$/.test(expr.slice(pos))) break;
      re.lastIndex = pos;
      m = re.exec(expr);
      if (!m) throw new Error(`Unexpected "${expr.slice(pos).trim().slice(0, 10)}"`);
      if (m[1] !== undefined) tokens.push({ num: Number(m[1]) });
      else if (m[2] !== undefined) tokens.push({ ref: m[2].trim() });
      else tokens.push({ op: m[3] });
      pos = re.lastIndex;
    }
    return tokens;
  }

  // Returns the field names a formula refers to.
  function references(expr) {
    try {
      return tokenize(expr).filter((t) => t.ref).map((t) => t.ref);
    } catch {
      return [];
    }
  }

  function evaluate(expr, lookup) {
    const tokens = tokenize(expr);
    let i = 0;
    const peek = () => tokens[i];
    const take = () => tokens[i++];
    function primary() {
      const t = take();
      if (!t) throw new Error('Formula ends too early');
      if (t.num !== undefined) return t.num;
      if (t.ref !== undefined) {
        const v = Number(lookup(t.ref));
        return Number.isFinite(v) ? v : 0;
      }
      if (t.op === '-') return -primary();
      if (t.op === '(') {
        const v = sum();
        if (take()?.op !== ')') throw new Error('Missing )');
        return v;
      }
      throw new Error(`Unexpected "${t.op}"`);
    }
    function product() {
      let v = primary();
      while (peek() && (peek().op === '*' || peek().op === '/')) {
        const op = take().op;
        const r = primary();
        v = op === '*' ? v * r : r === 0 ? NaN : v / r;
      }
      return v;
    }
    function sum() {
      let v = product();
      while (peek() && (peek().op === '+' || peek().op === '-')) {
        const op = take().op;
        const r = product();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    }
    if (!tokens.length) throw new Error('Formula is empty');
    const result = sum();
    if (i < tokens.length) throw new Error('Unexpected text after the formula');
    return result;
  }

  // Formatted result, or '' when it cannot be calculated (e.g. division by zero).
  function calculate(expr, lookup, decimals = 2) {
    try {
      const v = evaluate(expr, lookup);
      return Number.isFinite(v) ? v.toFixed(Math.min(6, Math.max(0, Number(decimals) || 0))) : '';
    } catch {
      return '';
    }
  }

  function check(expr) {
    try {
      evaluate(expr, () => 1);
      return '';
    } catch (e) {
      return e.message;
    }
  }

  const api = { calculate, check, references };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Formula = api;
})(this);
