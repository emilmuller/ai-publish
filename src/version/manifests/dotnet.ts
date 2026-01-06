function detectNewline(s: string): string {
	return s.includes("\r\n") ? "\r\n" : "\n"
}

function replaceFirstTagValue(
	raw: string,
	tagName: string,
	nextVersion: string
): { updated: boolean; content: string } {
	// Non-greedy inner match; matches across whitespace but not across another closing tag.
	const re = new RegExp(`<${tagName}>[\\s\\S]*?<\\/${tagName}>`, "m")
	const m = raw.match(re)
	if (!m) return { updated: false, content: raw }
	const replaced = raw.replace(re, `<${tagName}>${nextVersion}</${tagName}>`)
	return { updated: replaced !== raw, content: replaced }
}

export function updateCsprojVersion(raw: string, nextVersion: string): string {
	// Common conventions:
	//  - <Version>1.2.3</Version>
	//  - <PackageVersion>1.2.3</PackageVersion>
	// We update Version first, then PackageVersion.
	{
		const r = replaceFirstTagValue(raw, "Version", nextVersion)
		if (r.updated) return r.content
	}
	{
		const r = replaceFirstTagValue(raw, "PackageVersion", nextVersion)
		if (r.updated) return r.content
	}

	// If neither exists, insert <Version> into the first <PropertyGroup>.
	const newline = detectNewline(raw)
	const pgOpenRe = /<PropertyGroup(\s[^>]*)?>/m
	const m = raw.match(pgOpenRe)
	if (!m || m.index === undefined) {
		throw new Error("Unable to find <PropertyGroup> to insert <Version> into")
	}

	const insertAt = m.index + m[0].length
	// Try to preserve indentation: look at the next line's indentation, otherwise default to two spaces.
	const after = raw.slice(insertAt)
	const indentMatch = after.match(/^(\s*)\S/m)
	const indent = indentMatch ? indentMatch[1] : "  "

	const insertion = `${newline}${indent}<Version>${nextVersion}</Version>`
	return raw.slice(0, insertAt) + insertion + raw.slice(insertAt)
}
