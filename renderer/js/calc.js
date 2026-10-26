'use strict';
/* ============================================================
   الحاسبة: محلل تعبيرات آمن (بدون eval)
   ============================================================ */

let calcExpression = '';

/** حساب تعبير رياضي بسيط: + - * / % وأقواس. يرفض أي رموز أخرى. */
function calculateExpression(input) {
  const s = String(input).replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-');
  if (!s) return 0;
  let i = 0;
  const peek = () => s[i];
  const isDigit = (ch) => ch >= '0' && ch <= '9';

  function parseNumber() {
    const start = i;
    while (i < s.length && (isDigit(s[i]) || s[i] === '.')) i++;
    if (start === i) throw new Error('تعبير غير صالح');
    const value = Number(s.slice(start, i));
    if (!Number.isFinite(value)) throw new Error('رقم غير صالح');
    return value;
  }
  function parseFactor() {
    if (peek() === '-') { i++; return -parseFactor(); }
    if (peek() === '+') { i++; return parseFactor(); }
    if (peek() === '(') {
      i++;
      const value = parseExpression();
      if (peek() !== ')') throw new Error('قوس غير مغلق');
      i++;
      return value;
    }
    return parseNumber();
  }
  function parseTerm() {
    let value = parseFactor();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = s[i++];
      const right = parseFactor();
      if (op === '*') value *= right;
      else if (op === '/') {
        if (right === 0) throw new Error('قسمة على صفر');
        value /= right;
      } else {
        if (right === 0) throw new Error('قسمة على صفر');
        value %= right;
      }
    }
    return value;
  }
  function parseExpression() {
    let value = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = s[i++];
      const right = parseTerm();
      value = op === '+' ? value + right : value - right;
    }
    return value;
  }

  const result = parseExpression();
  if (i !== s.length) throw new Error('تعبير غير صالح');
  if (!Number.isFinite(result)) throw new Error('نتيجة غير صالحة');
  return Math.round(result * 1e10) / 1e10;
}

function updateCalcDisplay() {
  $('calcDisplay').value = calcExpression || '0';
}

function bindCalcEvents() {
  bind('calcBtn', 'click', () => {
    calcExpression = '';
    updateCalcDisplay();
    openModal('calculatorModal');
  });
  bind('closeCalcBtn', 'click', () => closeModal('calculatorModal'));
  $$('[data-calc]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.calc;
      if (key === 'C') {
        calcExpression = '';
      } else if (key === 'DEL') {
        calcExpression = calcExpression.slice(0, -1);
      } else if (key === '=') {
        try {
          calcExpression = String(calculateExpression(calcExpression));
        } catch (err) {
          calcExpression = 'خطأ';
          toast(err.message, 'error');
        }
      } else {
        if (calcExpression === 'خطأ') calcExpression = '';
        calcExpression += key;
      }
      updateCalcDisplay();
    });
  });
}
