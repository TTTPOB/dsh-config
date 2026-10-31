import { randomUUID } from "node:crypto";

export const name = "ptc-raw-text-reminder";
export const inject = ["tools"];

// Vendored js-tokens 9.0.1: https://registry.npmjs.org/js-tokens/-/js-tokens-9.0.1.tgz
// Exact upstream CommonJS source is enclosed unchanged in a local module wrapper.
/*
The MIT License (MIT)

Copyright (c) 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024 Simon Lydell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/
const jsTokens = (() => {
const module = { exports: {} };
// Copyright 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023 Simon Lydell
// License: MIT.
var HashbangComment, Identifier, JSXIdentifier, JSXPunctuator, JSXString, JSXText, KeywordsWithExpressionAfter, KeywordsWithNoLineTerminatorAfter, LineTerminatorSequence, MultiLineComment, Newline, NumericLiteral, Punctuator, RegularExpressionLiteral, SingleLineComment, StringLiteral, Template, TokensNotPrecedingObjectLiteral, TokensPrecedingExpression, WhiteSpace, jsTokens;
RegularExpressionLiteral = /\/(?![*\/])(?:\[(?:[^\]\\\n\r\u2028\u2029]+|\\.)*\]?|[^\/[\\\n\r\u2028\u2029]+|\\.)*(\/[$_\u200C\u200D\p{ID_Continue}]*|\\)?/yu;
Punctuator = /--|\+\+|=>|\.{3}|\??\.(?!\d)|(?:&&|\|\||\?\?|[+\-%&|^]|\*{1,2}|<{1,2}|>{1,3}|!=?|={1,2}|\/(?![\/*]))=?|[?~,:;[\](){}]/y;
Identifier = /(\x23?)(?=[$_\p{ID_Start}\\])(?:[$_\u200C\u200D\p{ID_Continue}]+|\\u[\da-fA-F]{4}|\\u\{[\da-fA-F]+\})+/yu;
StringLiteral = /(['"])(?:[^'"\\\n\r]+|(?!\1)['"]|\\(?:\r\n|[^]))*(\1)?/y;
NumericLiteral = /(?:0[xX][\da-fA-F](?:_?[\da-fA-F])*|0[oO][0-7](?:_?[0-7])*|0[bB][01](?:_?[01])*)n?|0n|[1-9](?:_?\d)*n|(?:(?:0(?!\d)|0\d*[89]\d*|[1-9](?:_?\d)*)(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?|0[0-7]+/y;
Template = /[`}](?:[^`\\$]+|\\[^]|\$(?!\{))*(`|\$\{)?/y;
WhiteSpace = /[\t\v\f\ufeff\p{Zs}]+/yu;
LineTerminatorSequence = /\r?\n|[\r\u2028\u2029]/y;
MultiLineComment = /\/\*(?:[^*]+|\*(?!\/))*(\*\/)?/y;
SingleLineComment = /\/\/.*/y;
HashbangComment = /^#!.*/;
JSXPunctuator = /[<>.:={}]|\/(?![\/*])/y;
JSXIdentifier = /[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}-]*/yu;
JSXString = /(['"])(?:[^'"]+|(?!\1)['"])*(\1)?/y;
JSXText = /[^<>{}]+/y;
TokensPrecedingExpression = /^(?:[\/+-]|\.{3}|\?(?:InterpolationIn(?:JSX|Template)|NoLineTerminatorHere|NonExpressionParenEnd|UnaryIncDec))?$|[{}([,;<>=*%&|^!~?:]$/;
TokensNotPrecedingObjectLiteral = /^(?:=>|[;\]){}]|else|\?(?:NoLineTerminatorHere|NonExpressionParenEnd))?$/;
KeywordsWithExpressionAfter = /^(?:await|case|default|delete|do|else|instanceof|new|return|throw|typeof|void|yield)$/;
KeywordsWithNoLineTerminatorAfter = /^(?:return|throw|yield)$/;
Newline = RegExp(LineTerminatorSequence.source);
module.exports = jsTokens = function*(input, {jsx = false} = {}) {
	var braces, firstCodePoint, isExpression, lastIndex, lastSignificantToken, length, match, mode, nextLastIndex, nextLastSignificantToken, parenNesting, postfixIncDec, punctuator, stack;
	({length} = input);
	lastIndex = 0;
	lastSignificantToken = "";
	stack = [
		{tag: "JS"}
	];
	braces = [];
	parenNesting = 0;
	postfixIncDec = false;
	if (match = HashbangComment.exec(input)) {
		yield ({
			type: "HashbangComment",
			value: match[0]
		});
		lastIndex = match[0].length;
	}
	while (lastIndex < length) {
		mode = stack[stack.length - 1];
		switch (mode.tag) {
			case "JS":
			case "JSNonExpressionParen":
			case "InterpolationInTemplate":
			case "InterpolationInJSX":
				if (input[lastIndex] === "/" && (TokensPrecedingExpression.test(lastSignificantToken) || KeywordsWithExpressionAfter.test(lastSignificantToken))) {
					RegularExpressionLiteral.lastIndex = lastIndex;
					if (match = RegularExpressionLiteral.exec(input)) {
						lastIndex = RegularExpressionLiteral.lastIndex;
						lastSignificantToken = match[0];
						postfixIncDec = true;
						yield ({
							type: "RegularExpressionLiteral",
							value: match[0],
							closed: match[1] !== void 0 && match[1] !== "\\"
						});
						continue;
					}
				}
				Punctuator.lastIndex = lastIndex;
				if (match = Punctuator.exec(input)) {
					punctuator = match[0];
					nextLastIndex = Punctuator.lastIndex;
					nextLastSignificantToken = punctuator;
					switch (punctuator) {
						case "(":
							if (lastSignificantToken === "?NonExpressionParenKeyword") {
								stack.push({
									tag: "JSNonExpressionParen",
									nesting: parenNesting
								});
							}
							parenNesting++;
							postfixIncDec = false;
							break;
						case ")":
							parenNesting--;
							postfixIncDec = true;
							if (mode.tag === "JSNonExpressionParen" && parenNesting === mode.nesting) {
								stack.pop();
								nextLastSignificantToken = "?NonExpressionParenEnd";
								postfixIncDec = false;
							}
							break;
						case "{":
							Punctuator.lastIndex = 0;
							isExpression = !TokensNotPrecedingObjectLiteral.test(lastSignificantToken) && (TokensPrecedingExpression.test(lastSignificantToken) || KeywordsWithExpressionAfter.test(lastSignificantToken));
							braces.push(isExpression);
							postfixIncDec = false;
							break;
						case "}":
							switch (mode.tag) {
								case "InterpolationInTemplate":
									if (braces.length === mode.nesting) {
										Template.lastIndex = lastIndex;
										match = Template.exec(input);
										lastIndex = Template.lastIndex;
										lastSignificantToken = match[0];
										if (match[1] === "${") {
											lastSignificantToken = "?InterpolationInTemplate";
											postfixIncDec = false;
											yield ({
												type: "TemplateMiddle",
												value: match[0]
											});
										} else {
											stack.pop();
											postfixIncDec = true;
											yield ({
												type: "TemplateTail",
												value: match[0],
												closed: match[1] === "`"
											});
										}
										continue;
									}
									break;
								case "InterpolationInJSX":
									if (braces.length === mode.nesting) {
										stack.pop();
										lastIndex += 1;
										lastSignificantToken = "}";
										yield ({
											type: "JSXPunctuator",
											value: "}"
										});
										continue;
									}
							}
							postfixIncDec = braces.pop();
							nextLastSignificantToken = postfixIncDec ? "?ExpressionBraceEnd" : "}";
							break;
						case "]":
							postfixIncDec = true;
							break;
						case "++":
						case "--":
							nextLastSignificantToken = postfixIncDec ? "?PostfixIncDec" : "?UnaryIncDec";
							break;
						case "<":
							if (jsx && (TokensPrecedingExpression.test(lastSignificantToken) || KeywordsWithExpressionAfter.test(lastSignificantToken))) {
								stack.push({tag: "JSXTag"});
								lastIndex += 1;
								lastSignificantToken = "<";
								yield ({
									type: "JSXPunctuator",
									value: punctuator
								});
								continue;
							}
							postfixIncDec = false;
							break;
						default:
							postfixIncDec = false;
					}
					lastIndex = nextLastIndex;
					lastSignificantToken = nextLastSignificantToken;
					yield ({
						type: "Punctuator",
						value: punctuator
					});
					continue;
				}
				Identifier.lastIndex = lastIndex;
				if (match = Identifier.exec(input)) {
					lastIndex = Identifier.lastIndex;
					nextLastSignificantToken = match[0];
					switch (match[0]) {
						case "for":
						case "if":
						case "while":
						case "with":
							if (lastSignificantToken !== "." && lastSignificantToken !== "?.") {
								nextLastSignificantToken = "?NonExpressionParenKeyword";
							}
					}
					lastSignificantToken = nextLastSignificantToken;
					postfixIncDec = !KeywordsWithExpressionAfter.test(match[0]);
					yield ({
						type: match[1] === "#" ? "PrivateIdentifier" : "IdentifierName",
						value: match[0]
					});
					continue;
				}
				StringLiteral.lastIndex = lastIndex;
				if (match = StringLiteral.exec(input)) {
					lastIndex = StringLiteral.lastIndex;
					lastSignificantToken = match[0];
					postfixIncDec = true;
					yield ({
						type: "StringLiteral",
						value: match[0],
						closed: match[2] !== void 0
					});
					continue;
				}
				NumericLiteral.lastIndex = lastIndex;
				if (match = NumericLiteral.exec(input)) {
					lastIndex = NumericLiteral.lastIndex;
					lastSignificantToken = match[0];
					postfixIncDec = true;
					yield ({
						type: "NumericLiteral",
						value: match[0]
					});
					continue;
				}
				Template.lastIndex = lastIndex;
				if (match = Template.exec(input)) {
					lastIndex = Template.lastIndex;
					lastSignificantToken = match[0];
					if (match[1] === "${") {
						lastSignificantToken = "?InterpolationInTemplate";
						stack.push({
							tag: "InterpolationInTemplate",
							nesting: braces.length
						});
						postfixIncDec = false;
						yield ({
							type: "TemplateHead",
							value: match[0]
						});
					} else {
						postfixIncDec = true;
						yield ({
							type: "NoSubstitutionTemplate",
							value: match[0],
							closed: match[1] === "`"
						});
					}
					continue;
				}
				break;
			case "JSXTag":
			case "JSXTagEnd":
				JSXPunctuator.lastIndex = lastIndex;
				if (match = JSXPunctuator.exec(input)) {
					lastIndex = JSXPunctuator.lastIndex;
					nextLastSignificantToken = match[0];
					switch (match[0]) {
						case "<":
							stack.push({tag: "JSXTag"});
							break;
						case ">":
							stack.pop();
							if (lastSignificantToken === "/" || mode.tag === "JSXTagEnd") {
								nextLastSignificantToken = "?JSX";
								postfixIncDec = true;
							} else {
								stack.push({tag: "JSXChildren"});
							}
							break;
						case "{":
							stack.push({
								tag: "InterpolationInJSX",
								nesting: braces.length
							});
							nextLastSignificantToken = "?InterpolationInJSX";
							postfixIncDec = false;
							break;
						case "/":
							if (lastSignificantToken === "<") {
								stack.pop();
								if (stack[stack.length - 1].tag === "JSXChildren") {
									stack.pop();
								}
								stack.push({tag: "JSXTagEnd"});
							}
					}
					lastSignificantToken = nextLastSignificantToken;
					yield ({
						type: "JSXPunctuator",
						value: match[0]
					});
					continue;
				}
				JSXIdentifier.lastIndex = lastIndex;
				if (match = JSXIdentifier.exec(input)) {
					lastIndex = JSXIdentifier.lastIndex;
					lastSignificantToken = match[0];
					yield ({
						type: "JSXIdentifier",
						value: match[0]
					});
					continue;
				}
				JSXString.lastIndex = lastIndex;
				if (match = JSXString.exec(input)) {
					lastIndex = JSXString.lastIndex;
					lastSignificantToken = match[0];
					yield ({
						type: "JSXString",
						value: match[0],
						closed: match[2] !== void 0
					});
					continue;
				}
				break;
			case "JSXChildren":
				JSXText.lastIndex = lastIndex;
				if (match = JSXText.exec(input)) {
					lastIndex = JSXText.lastIndex;
					lastSignificantToken = match[0];
					yield ({
						type: "JSXText",
						value: match[0]
					});
					continue;
				}
				switch (input[lastIndex]) {
					case "<":
						stack.push({tag: "JSXTag"});
						lastIndex++;
						lastSignificantToken = "<";
						yield ({
							type: "JSXPunctuator",
							value: "<"
						});
						continue;
					case "{":
						stack.push({
							tag: "InterpolationInJSX",
							nesting: braces.length
						});
						lastIndex++;
						lastSignificantToken = "?InterpolationInJSX";
						postfixIncDec = false;
						yield ({
							type: "JSXPunctuator",
							value: "{"
						});
						continue;
				}
		}
		WhiteSpace.lastIndex = lastIndex;
		if (match = WhiteSpace.exec(input)) {
			lastIndex = WhiteSpace.lastIndex;
			yield ({
				type: "WhiteSpace",
				value: match[0]
			});
			continue;
		}
		LineTerminatorSequence.lastIndex = lastIndex;
		if (match = LineTerminatorSequence.exec(input)) {
			lastIndex = LineTerminatorSequence.lastIndex;
			postfixIncDec = false;
			if (KeywordsWithNoLineTerminatorAfter.test(lastSignificantToken)) {
				lastSignificantToken = "?NoLineTerminatorHere";
			}
			yield ({
				type: "LineTerminatorSequence",
				value: match[0]
			});
			continue;
		}
		MultiLineComment.lastIndex = lastIndex;
		if (match = MultiLineComment.exec(input)) {
			lastIndex = MultiLineComment.lastIndex;
			if (Newline.test(match[0])) {
				postfixIncDec = false;
				if (KeywordsWithNoLineTerminatorAfter.test(lastSignificantToken)) {
					lastSignificantToken = "?NoLineTerminatorHere";
				}
			}
			yield ({
				type: "MultiLineComment",
				value: match[0],
				closed: match[1] !== void 0
			});
			continue;
		}
		SingleLineComment.lastIndex = lastIndex;
		if (match = SingleLineComment.exec(input)) {
			lastIndex = SingleLineComment.lastIndex;
			postfixIncDec = false;
			yield ({
				type: "SingleLineComment",
				value: match[0]
			});
			continue;
		}
		firstCodePoint = String.fromCodePoint(input.codePointAt(lastIndex));
		lastIndex += firstCodePoint.length;
		lastSignificantToken = firstCodePoint;
		postfixIncDec = false;
		yield ({
			type: mode.tag.startsWith("JSX") ? "JSXInvalid" : "Invalid",
			value: firstCodePoint
		});
	}
	return void 0;
};
return module.exports;
})();

export const DEFAULTS = {
  enabled: true,
  newlineEscapeThreshold: 2,
  escapedQuoteLengthThreshold: 80,
  successText: "This run_code call succeeded; do not rerun it.",
  suggestionText: "builds text with escapes. Next time write it as a raw text literal:",
  failureText: "Rewrite strings with quotes or newlines as @``…``.",
  moreText: "additional hits.",
};

export const Config = {
  "~standard": {
    version: 1, vendor: name,
    validate(input) {
      if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).some(key => !Object.hasOwn(DEFAULTS, key))) {
        return { issues: [{ message: "Expected reminder configuration keys" }] };
      }
      const value = { ...DEFAULTS, ...input };
      if (typeof value.enabled !== "boolean"
        || ["newlineEscapeThreshold", "escapedQuoteLengthThreshold"].some(key => !Number.isSafeInteger(value[key]) || value[key] < 1)
        || ["successText", "suggestionText", "failureText", "moreText"].some(key => typeof value[key] !== "string" || !value[key].trim())) {
        return { issues: [{ message: "Expected boolean enabled, positive integer thresholds and nonempty texts" }] };
      }
      return { value };
    },
  },
};

function tokensWithOffsets(code) {
  let offset = 0;
  return [...jsTokens(code)].map(token => {
    const item = { ...token, start: offset };
    offset += token.value.length;
    return item;
  });
}

/** Mask only raw openings in code, not in comments, regexes or quoted text. */
export function maskRawLiterals(code) {
  let masked = code;
  for (;;) {
    const opening = tokensWithOffsets(masked).find(token => token.value === "@" && /^@`{2,}/.test(masked.slice(token.start)));
    if (!opening) return masked;
    const start = opening.start;
    const count = /^@(`+)/.exec(masked.slice(start))[1].length;
    const runs = /`+/g;
    runs.lastIndex = start + count + 1;
    let end = masked.length, match;
    while ((match = runs.exec(masked))) {
      if (match[0].length === count) { end = runs.lastIndex; break; }
    }
    masked = masked.slice(0, start) + masked.slice(start, end).replace(/[^\r\n\u2028\u2029]/g, " ") + masked.slice(end);
  }
}

/** Decode literals without evaluating model code; unknown escapes omit the preview. */
export function decodeLiteral(literal) {
  const quote = literal[0];
  if (!["'", '"', "`"].includes(quote) || literal.at(-1) !== quote) return undefined;
  const body = literal.slice(1, -1);
  let value = "";
  const simple = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "\\": "\\", '"': '"', "'": "'", "`": "`", "$": "$" };
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quote === "`" && char === "$" && body[i + 1] === "{") return undefined;
    if (char !== "\\") { value += char; continue; }
    const next = body[++i];
    if (Object.hasOwn(simple, next)) { value += simple[next]; continue; }
    if (next === "\n") continue;
    if (next === "\r") { if (body[i + 1] === "\n") i++; continue; }
    const rest = body.slice(i);
    const hex = /^(?:x([\da-fA-F]{2})|u([\da-fA-F]{4})|u\{([\da-fA-F]+)\})/.exec(rest);
    if (!hex) return undefined;
    const point = parseInt(hex[1] ?? hex[2] ?? hex[3], 16);
    if (point > 0x10ffff) return undefined;
    value += String.fromCodePoint(point);
    i += hex[0].length - 1;
  }
  return value;
}

export function detectComplexText(code, config = DEFAULTS) {
  const tokens = tokensWithOffsets(maskRawLiterals(code)).filter(token => !/^(?:WhiteSpace|LineTerminatorSequence|.*Comment)$/.test(token.type));
  const hits = new Map();
  function add(token, value = decodeLiteral(token.value), end = token.start + token.value.length) {
    hits.set(token.start, { line: code.slice(0, token.start).split(/\r\n|[\n\r\u2028\u2029]/).length, snippet: code.slice(token.start, end), value, start: token.start });
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], text = token.value;
    if (token.type === "StringLiteral") {
      const escapes = text.match(/\\(?:\r\n|[\s\S])/g) ?? [];
      if (escapes.filter(part => part === "\\n").length >= config.newlineEscapeThreshold
        || (text.length > config.escapedQuoteLengthThreshold && escapes.some(part => part === '\\"' || part === "\\'"))) add(token);
    }
    if (token.type.includes("Template") && /\\(?:`|\$\{)/.test(text)) add(token);
    if (text === "String" && tokens[i + 1]?.value === "." && tokens[i + 2]?.value === "raw") {
      const literal = tokens[i + 3];
      // String.raw preserves escapes, unlike ordinary templates.
      const value = literal?.type === "NoSubstitutionTemplate" && literal.closed ? literal.value.slice(1, -1) : undefined;
      add(token, value, literal ? literal.start + literal.value.length : tokens[i + 2].start + 3);
    }
    if (text !== "[") continue;
    let j = i + 1;
    const values = [];
    while (tokens[j]?.type === "StringLiteral") {
      values.push(decodeLiteral(tokens[j].value)); j++;
      if (tokens[j]?.value !== ",") break;
      j++;
    }
    if (!values.length || tokens[j]?.value !== "]") continue;
    if (tokens[j + 1]?.value === "." && tokens[j + 2]?.value === "join" && tokens[j + 3]?.value === "("
      && tokens[j + 4]?.type === "StringLiteral" && decodeLiteral(tokens[j + 4].value) === "\n" && tokens[j + 5]?.value === ")") {
      add(token, values.every(value => value !== undefined) ? values.join("\n") : undefined, tokens[j + 5].start + 1);
    }
  }
  return [...hits.values()].sort((a, b) => a.start - b.start);
}

export function renderRawLiteral(value) {
  const breaks = [...value.matchAll(/\r\n|[\n\r\u2028\u2029]/g)];
  const shown = value.slice(0, Math.min(breaks[2]?.index ?? value.length, 300));
  // Keep the truncation marker outside the literal so it cannot read as content.
  const marker = shown.length < value.length ? " (truncated)" : "";
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map(run => run.length));
  const delimiter = "`".repeat(Math.max(2, longest + 1));
  return "@" + delimiter + "\n" + shown + (shown.endsWith("`") ? "\n" : "") + delimiter + marker;
}

function errorText(result) {
  return [typeof result.error === "string" ? result.error : result.error?.message,
    ...(result.content ?? []).filter(part => part.type === "text").map(part => part.text)].filter(Boolean).join("\n");
}

export function apply(ctx, config) {
  ctx.on("tools/post-execute", async (exec, result, next) => {
    const downstream = await next();
    if (!config.enabled || exec.name !== "run_code" || exec.parent !== undefined || typeof exec.arguments?.code !== "string") return downstream;
    const hits = detectComplexText(exec.arguments.code, config);
    let text;
    if (result.isError) {
      const error = errorText(result);
      if (!hits.length && !/(?:^SyntaxError\b|SyntaxError at \d+:\d+:)/m.test(error) && !error.includes("Unterminated raw string literal") && !error.includes("Location (JavaScript parse")) return downstream;
      text = config.failureText;
      if (hits.length) text += " Line " + hits[0].line + ": " + hits[0].snippet.replace(/\s+/g, " ").slice(0, 80);
    } else {
      if (!hits.length) return downstream;
      text = config.successText + " Line " + hits[0].line + " " + config.suggestionText;
      if (hits[0].value !== undefined) text += "\n" + renderRawLiteral(hits[0].value);
      if (hits.length > 1) text += "\n" + (hits.length - 1) + " " + config.moreText;
    }
    const message = { id: randomUUID(), role: "user", content: [{ type: "text", text }], source: { kind: name } };
    return { ...downstream, additionalContexts: [...(downstream.additionalContexts ?? []), message] };
  });
}
