/**
 * A tiny expression evaluator for plotting `y = f(x)`.
 *
 * Deliberately its own grammar rather than anything that reaches the JS
 * evaluator: `new Function` would execute whatever an agent (or a document, or
 * a future untrusted caller) put in it, and would also be non-deterministic the
 * moment someone wrote `Math.random()`. This parser knows numbers, `x`, five
 * operators, parentheses and a fixed whitelist of functions — nothing else can
 * be reached, so evaluation is pure by construction.
 *
 * Nothing here is stored in a document. Plotting samples the function at author
 * time and writes the resulting points into a `path` node, exactly as `animate`
 * bakes keyframes from a sampled current value. The renderer therefore never
 * sees an expression and the purity invariant needs no new argument.
 */

export class ExprError extends Error {}

const FUNCS: Record<string, (v: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  sqrt: Math.sqrt,
  abs: Math.abs,
  sign: Math.sign,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
}

const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E }

/** Names a caller can use, for an error that can list them. */
export const EXPR_FUNCTIONS = Object.keys(FUNCS)
export const EXPR_CONSTANTS = Object.keys(CONSTS)

type Node =
  | { kind: 'num'; value: number }
  | { kind: 'var' }
  | { kind: 'unary'; operand: Node }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/' | '^'; left: Node; right: Node }
  | { kind: 'call'; name: string; arg: Node }

/**
 * Parse once, evaluate many times.
 *
 * Sampling a curve means calling this a few hundred times, and re-parsing per
 * sample would make the cost of a smooth curve quadratic in nothing useful.
 */
export function compileExpression(source: string): (x: number) => number {
  const ast = parse(source)
  return (x: number) => evaluate(ast, x)
}

/** Convenience for a single evaluation; prefer `compileExpression` in a loop. */
export function evaluateExpression(source: string, x: number): number {
  return compileExpression(source)(x)
}

// ---------- tokenizer ----------

type Token = { type: 'num'; value: number } | { type: 'name'; value: string } | { type: 'op'; value: string }

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === ' ' || c === '\t' || c === '\n') {
      i++
      continue
    }
    if (/[0-9.]/.test(c)) {
      const start = i
      while (i < src.length && /[0-9.]/.test(src[i]!)) i++
      const raw = src.slice(start, i)
      const value = Number(raw)
      if (!Number.isFinite(value)) throw new ExprError(`"${raw}" is not a number`)
      tokens.push({ type: 'num', value })
      continue
    }
    if (/[a-zA-Z_]/.test(c)) {
      const start = i
      while (i < src.length && /[a-zA-Z_0-9]/.test(src[i]!)) i++
      tokens.push({ type: 'name', value: src.slice(start, i) })
      continue
    }
    if ('+-*/^(),'.includes(c)) {
      // `**` is accepted as a synonym for `^`: it is what a caller used to
      // writing code reaches for, and silently treating it as two
      // multiplications would be the worst possible outcome.
      if (c === '*' && src[i + 1] === '*') {
        tokens.push({ type: 'op', value: '^' })
        i += 2
        continue
      }
      tokens.push({ type: 'op', value: c })
      i++
      continue
    }
    throw new ExprError(`unexpected character "${c}" at position ${i}`)
  }
  return tokens
}

// ---------- recursive-descent parser ----------
// expr := term (('+' | '-') term)*
// term := unary (('*' | '/') unary)*
// unary := '-' unary | power
// power := primary ('^' unary)?      — right-associative, so 2^3^2 = 2^9
// primary := number | 'x' | const | func '(' expr ')' | '(' expr ')'
//
// `power` sits *below* `unary` on purpose: by mathematical convention -x^2 is
// -(x^2), not (-x)^2. Getting this backwards is silent — it returns a number,
// just the wrong one, for exactly the expressions people plot most. (JavaScript
// sidesteps the question by making `-x ** y` a syntax error; here the notation
// is maths rather than code, and maths has an unambiguous answer.) Putting the
// exponent's right side back through `unary` is what allows 2^-3.

function parse(source: string): Node {
  const tokens = tokenize(source)
  let pos = 0

  const peek = (): Token | undefined => tokens[pos]
  const eat = (value: string): boolean => {
    const t = peek()
    if (t && t.type === 'op' && t.value === value) {
      pos++
      return true
    }
    return false
  }

  function expr(): Node {
    let left = term()
    for (;;) {
      if (eat('+')) left = { kind: 'binary', op: '+', left, right: term() }
      else if (eat('-')) left = { kind: 'binary', op: '-', left, right: term() }
      else return left
    }
  }

  function term(): Node {
    let left = unary()
    for (;;) {
      if (eat('*')) left = { kind: 'binary', op: '*', left, right: unary() }
      else if (eat('/')) left = { kind: 'binary', op: '/', left, right: unary() }
      else return left
    }
  }

  function unary(): Node {
    if (eat('-')) return { kind: 'unary', operand: unary() }
    if (eat('+')) return unary()
    return power()
  }

  function power(): Node {
    const base = primary()
    // The right side goes back through `unary`, which both makes `^`
    // right-associative and allows a negative exponent (2^-3).
    if (eat('^')) return { kind: 'binary', op: '^', left: base, right: unary() }
    return base
  }

  function primary(): Node {
    const t = peek()
    if (!t) throw new ExprError('unexpected end of expression')
    if (t.type === 'num') {
      pos++
      return { kind: 'num', value: t.value }
    }
    if (t.type === 'name') {
      pos++
      const name = t.value.toLowerCase()
      if (eat('(')) {
        const fn = FUNCS[name]
        if (!fn) {
          throw new ExprError(
            `unknown function "${t.value}". Available: ${EXPR_FUNCTIONS.join(', ')}`,
          )
        }
        const arg = expr()
        if (!eat(')')) throw new ExprError(`missing ")" after ${name}(`)
        return { kind: 'call', name, arg }
      }
      if (name === 'x') return { kind: 'var' }
      if (name in CONSTS) return { kind: 'num', value: CONSTS[name]! }
      throw new ExprError(
        `unknown name "${t.value}". The variable is \`x\`; constants are ` +
          `${EXPR_CONSTANTS.join(', ')}; functions are ${EXPR_FUNCTIONS.join(', ')}.`,
      )
    }
    if (eat('(')) {
      const inner = expr()
      if (!eat(')')) throw new ExprError('missing ")"')
      return inner
    }
    throw new ExprError(`unexpected "${t.value}"`)
  }

  const ast = expr()
  if (pos !== tokens.length) {
    // Implicit multiplication (`2x`) is rejected rather than guessed at: a
    // caller who meant `2*x` gets told, and one who typo'd does not get a
    // silently different curve.
    throw new ExprError(
      `unexpected "${(tokens[pos] as { value: unknown }).value}" — ` +
        `write multiplication explicitly, e.g. 2*x rather than 2x`,
    )
  }
  return ast
}

function evaluate(node: Node, x: number): number {
  switch (node.kind) {
    case 'num':
      return node.value
    case 'var':
      return x
    case 'unary':
      return -evaluate(node.operand, x)
    case 'call':
      return FUNCS[node.name]!(evaluate(node.arg, x))
    case 'binary': {
      const a = evaluate(node.left, x)
      const b = evaluate(node.right, x)
      switch (node.op) {
        case '+':
          return a + b
        case '-':
          return a - b
        case '*':
          return a * b
        case '/':
          return a / b
        case '^':
          return a ** b
      }
    }
  }
}
