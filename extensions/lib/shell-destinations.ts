import { basename, resolve } from "node:path";
import { homedir } from "node:os";
import type { Destination } from "./path-policy.ts";

interface Word { value: string; literal: boolean }
type Token = Word | string;
export interface ShellDestination extends Destination { cwd: string }

// Deliberately a literal-command lexer, not a shell interpreter. No expansion or execution.
function tokenize(command: string): Token[] | undefined {
	const tokens: Token[] = [];
	let value = "", started = false, literal = true, unquotedTilde = false;
	let quote: "'" | '"' | undefined;
	const flush = () => {
		if (value.startsWith("~")) {
			if (!unquotedTilde) value = `./${value}`;
			else if (value === "~" || value.startsWith("~/")) value = resolve(homedir(), value.slice(2));
			else literal = false; // ~user requires account lookup, not literal expansion.
		}
		if (started) tokens.push({ value, literal });
		value = ""; started = false; literal = true; unquotedTilde = false;
	};
	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (quote === "'") {
			if (char === "'") quote = undefined;
			else value += char;
			continue;
		}
		if (char === "\\") {
			const next = command[++i];
			if (next === undefined) return;
			if (next === "\n") continue;
			if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) value += "\\";
			value += next; started = true; continue;
		}
		if (quote === '"') {
			if (char === '"') quote = undefined;
			else {
				if (char === "`" || (char === "$" && command[i + 1] === "(")) return;
				if (char === "$") literal = false;
				value += char;
			}
			continue;
		}
		if (char === "'" || char === '"') { quote = char; started = true; continue; }
		if (char === "`" || (char === "$" && command[i + 1] === "(")) return;
		if (char === "#" && !started) {
			while (i < command.length && command[i] !== "\n") i++;
			flush(); tokens.push(";"); continue;
		}
		if (char === "\n") { flush(); tokens.push(";"); continue; }
		if (/\s/.test(char)) { flush(); continue; }
		if (";&|><()".includes(char)) {
			flush();
			const pair = char + (command[i + 1] ?? "");
			if (["<<", "<(", ">("].includes(pair) || char === "(" || char === ")") return;
			if (["&&", "||", ">>", ">|", ">&", "<&"].includes(pair)) { tokens.push(pair); i++; }
			else tokens.push(char);
			continue;
		}
		if ("$*?[]{}".includes(char)) literal = false;
		if (char === "~" && !started) unquotedTilde = true;
		value += char; started = true;
	}
	if (quote) return;
	flush();
	return tokens;
}

function options(words: Word[], command: string): { paths: string[]; target?: string; noTarget: boolean } | undefined {
	const paths: string[] = [];
	let target: string | undefined, noTarget = false, ended = false;
	const flags: Record<string, RegExp> = {
		mv: /^-[finvTb]+$/, cp: /^-[RrPpdfinvaTx]+$/, mkdir: /^-[pv]+$/, touch: /^-[acm]+$/, tee: /^-[ai]+$/,
	};
	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		if (!word.literal) return;
		const value = word.value;
		if (!ended && value === "--") { ended = true; continue; }
		if (!ended && value.startsWith("-") && value !== "-") {
			if (["mv", "cp"].includes(command) && (value === "-t" || value === "--target-directory")) {
				if (!words[++i]?.literal) return;
				target = words[i].value; continue;
			}
			if (["mv", "cp"].includes(command) && value.startsWith("--target-directory=")) { target = value.slice(19); continue; }
			if (value === "--no-target-directory" && ["mv", "cp"].includes(command)) { noTarget = true; continue; }
			if ((command === "mkdir" && ["-m", "--mode"].includes(value)) || (command === "touch" && ["-t", "-d", "-r", "--date", "--reference"].includes(value))) {
				if (!words[++i]?.literal) return;
				continue;
			}
			if (flags[command]?.test(value)) { if (value.includes("T")) noTarget = true; continue; }
			if ((command === "mkdir" && value === "--parents") ||
				(command === "cp" && ["--recursive", "--archive"].includes(value)) ||
				(command === "tee" && value === "--append")) continue;
			return;
		}
		paths.push(value);
	}
	if (target !== undefined && noTarget) return;
	return { paths, target, noTarget };
}

export function shellDestinations(command: string, initialCwd: string): ShellDestination[] {
	const tokens = tokenize(command);
	if (!tokens) return [];
	// Compound control flow needs a real shell interpreter; don't guess its working directory.
	const control = new Set(["if", "then", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "function", "eval", "source", ".", "pushd", "popd"]);
	if (tokens.some((token, index) => typeof token !== "string" && control.has(token.value) &&
		(index === 0 || [";", "&&", "||", "|", "&"].includes(String(tokens[index - 1]))))) return [];
	const result: ShellDestination[] = [];
	let cwd = initialCwd;
	let words: Word[] = [];
	let cwdKnown = true;
	const add = (destination: Destination) => { if (cwdKnown) result.push({ ...destination, cwd }); };
	const finish = (separator?: string) => {
		const name = words[0]?.literal ? basename(words[0].value) : "";
		if (name === "cd") {
			if (separator !== "&&") cwdKnown = false;
			else if (words.length === 2 && words[1].literal && words[1].value !== "-") {
				const path = words[1].value;
				cwd = resolve(cwd, path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path);
			} else cwdKnown = false;
		} else if (["mv", "cp", "mkdir", "touch", "tee"].includes(name)) {
			const parsed = options(words.slice(1), name);
			if (parsed) {
				if (["mkdir", "touch", "tee"].includes(name)) {
					for (const path of parsed.paths) if (path !== "-") add({ path });
				} else {
					const paths = [...parsed.paths];
					const target = parsed.target ?? paths.pop();
					if (target && paths.length) for (const source of paths) {
						add({ path: target, source,
							intoDirectory: parsed.noTarget ? false : parsed.target !== undefined || paths.length > 1 || target.endsWith("/") ? true : undefined });
					}
				}
			}
		}
		if (separator === "||" && cwd !== initialCwd) cwdKnown = false;
		words = [];
	};
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (typeof token !== "string") { words.push(token); continue; }
		if ([">", ">>", ">|", "<", ">&", "<&"].includes(token)) {
			const target = tokens[++i];
			if (typeof target !== "string" && target?.literal && [">", ">>", ">|"].includes(token)) add({ path: target.value });
			// Remove an adjacent file descriptor from the command's operand list.
			if (words.at(-1)?.value.match(/^\d+$/)) words.pop();
		} else finish(token);
	}
	finish();
	return result;
}
