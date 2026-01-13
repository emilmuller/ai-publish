const fs = require("node:fs")

const path = "dist/cli.js"
let buf
try {
	buf = fs.readFileSync(path, "utf8")
} catch (e) {
	console.error(`[ai-publish] verify-cli-shebang: missing ${path}`)
	process.exit(1)
}

const firstLine = buf.split(/\r?\n/)[0]
if (firstLine !== "#!/usr/bin/env node") {
	console.error(
		`[ai-publish] verify-cli-shebang: ${path} must start with '#!/usr/bin/env node' but got: ${JSON.stringify(firstLine)}`
	)
	process.exit(1)
}
