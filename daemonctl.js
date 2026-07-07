const path = require('path');
const { execFileSync } = require('child_process');
const fsSync = require('fs');
const fs = require('fs/promises');
const { TlsManager } = require('./src/tlsManager');

function usage() {
	console.log('Usage:');
	console.log('  node daemonctl.js generate-tls-cert [--cn <name>] [--bits <1024-8192>] [--days <1-36500>]');
	console.log('  node daemonctl.js generate-tls-cert --signed [--cn <primary-domain>] [--domain <domain>] [--webroot <path>] [--bits <1024-8192>]');
	console.log('  node daemonctl.js fix-tls-perms');
	process.exit(1);
}

function isRunningInsideDocker() {
	return fsSync.existsSync('/.dockerenv');
}

function scheduleContainerRestart() {
	if (!isRunningInsideDocker()) {
		try {
			execFileSync(
				'sh',
				['-lc', 'docker compose restart coturn >/dev/null 2>&1 || docker-compose restart coturn >/dev/null 2>&1'],
				{ cwd: __dirname, stdio: 'ignore' },
			);
			return true;
		} catch {
			return false;
		}
	}

	execFileSync(
		'sh',
		['-lc', '(sleep 1; kill -TERM 1) >/dev/null 2>&1 &'],
		{ stdio: 'ignore' },
	);

	return true;
}

function extractGenerateCertArgs(args) {
	const values = [...args];
	let cn = 'turn.local';
	let bits;
	let days;
	let signed = false;
	let webroot = '/var/www/html';
	const domains = [];

	for (let index = 0; index < values.length; index += 1) {
		const value = String(values[index] || '').trim();
		if (value === '--signed') {
			signed = true;
			values.splice(index, 1);
			index -= 1;
			continue;
		}
		if (value === '--cn') {
			cn = String(values[index + 1] || '').trim() || cn;
			values.splice(index, 2);
			index -= 1;
			continue;
		}
		if (value === '--domain') {
			const domain = String(values[index + 1] || '').trim();
			if (!domain) {
				usage();
			}
			domains.push(domain);
			values.splice(index, 2);
			index -= 1;
			continue;
		}
		if (value === '--webroot') {
			webroot = String(values[index + 1] || '').trim() || webroot;
			values.splice(index, 2);
			index -= 1;
			continue;
		}
		if (value === '--bits') {
			bits = Number(values[index + 1]);
			values.splice(index, 2);
			index -= 1;
			continue;
		}
		if (value === '--days') {
			days = Number(values[index + 1]);
			values.splice(index, 2);
			index -= 1;
		}
	}

	if (values.length > 0) {
		usage();
	}

	if (bits !== undefined && (!Number.isInteger(bits) || bits < 1024 || bits > 8192)) {
		console.error('[daemonctl] generate-tls-cert: --bits must be an integer between 1024 and 8192');
		process.exit(1);
	}

	if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 36500)) {
		console.error('[daemonctl] generate-tls-cert: --days must be an integer between 1 and 36500');
		process.exit(1);
	}

	if (signed && days !== undefined) {
		console.error('[daemonctl] generate-tls-cert: --days is only supported for self-signed certificates');
		process.exit(1);
	}

	if (signed && !webroot) {
		console.error('[daemonctl] generate-tls-cert: --webroot is required when --signed is used');
		process.exit(1);
	}

	return { cn, bits, days, signed, webroot, domains };
}

function normalizeDomains(cn, explicitDomains = []) {
	const all = [String(cn || '').trim(), ...explicitDomains.map((value) => String(value || '').trim())]
		.filter(Boolean)
		.map((value) => value.toLowerCase());

	return [...new Set(all)];
}

function runCertbotWebroot(domains, webroot, bits) {
	if (!Array.isArray(domains) || domains.length === 0) {
		throw new Error('at least one domain is required for --signed');
	}

	const certbotCmd = [
		'certbot',
		'certonly',
		'--webroot',
		'-w', webroot,
		'--rsa-key-size', String(Number.isInteger(bits) ? bits : 4096),
		'--non-interactive',
		'--agree-tos',
		'--register-unsafely-without-email',
		...domains.flatMap((domain) => ['-d', domain]),
	].join(' ');

	const shellCmd = `if [ "$(id -u)" -eq 0 ]; then ${certbotCmd}; else sudo ${certbotCmd}; fi`;

	try {
		execFileSync('sh', ['-lc', shellCmd], { stdio: 'inherit' });
	} catch (err) {
		const msg = err.stderr ? String(err.stderr).trim() : err.message;
		throw new Error(`certbot failed: ${msg}`);
	}
}

function shellEscape(value) {
	return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function installLetsEncryptCert({ certDir, tlsManager, primaryDomain }) {
	const liveDir = path.join('/etc/letsencrypt/live', primaryDomain);
	const fullchain = path.join(liveDir, 'fullchain.pem');
	const privkey = path.join(liveDir, 'privkey.pem');
	const certPath = path.join(certDir, 'cert.pem');
	const keyPath = path.join(certDir, 'key.pem');

	try {
		await fs.mkdir(certDir, { recursive: true });
		await Promise.all([
			fs.copyFile(fullchain, certPath),
			fs.copyFile(privkey, keyPath),
		]);

		await tlsManager.fixPermissions();
		return;
	} catch (error) {
		if (!['EACCES', 'EPERM'].includes(error.code)) {
			throw error;
		}
	}

	const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
	const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
	if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
		throw new Error('cannot resolve current uid/gid to install signed certificate');
	}

	const sudoInstallCmd = [
		'sudo', 'install', '-d', '-m', '700', '-o', String(uid), '-g', String(gid), shellEscape(certDir),
		'&&', 'sudo', 'install', '-m', '644', '-o', String(uid), '-g', String(gid), shellEscape(fullchain), shellEscape(certPath),
		'&&', 'sudo', 'install', '-m', '600', '-o', String(uid), '-g', String(gid), shellEscape(privkey), shellEscape(keyPath),
	].join(' ');

	try {
		execFileSync('sh', ['-lc', sudoInstallCmd], { stdio: 'inherit' });
	} catch (error) {
		const msg = error.stderr ? String(error.stderr).trim() : error.message;
		throw new Error(`cannot install signed certificate files from /etc/letsencrypt: ${msg}`);
	}
}

async function main() {
	const [, , command, ...rest] = process.argv;
	if (!command || command === 'help' || command === '--help' || command === '-h') {
		usage();
	}

	const certDir = path.join(__dirname, 'cert');
	const tlsManager = new TlsManager(certDir);

	if (command === 'generate-tls-cert') {
		const {
			cn,
			bits,
			days,
			signed,
			webroot,
			domains: explicitDomains,
		} = extractGenerateCertArgs(rest);

		if (signed) {
			const domains = normalizeDomains(cn, explicitDomains);
			runCertbotWebroot(domains, webroot, bits);
			await installLetsEncryptCert({
				certDir,
				tlsManager,
				primaryDomain: domains[0],
			});

			const result = await tlsManager.getCertInfo();
			console.log(`cert.pem: ${path.join(certDir, 'cert.pem')}`);
			console.log(`key.pem:  ${path.join(certDir, 'key.pem')}`);
			console.log(`mode:     signed (Let's Encrypt)`);
			console.log(`domains:  ${domains.join(', ')}`);
			console.log(`subject:  ${result.subject || '-'}`);
			console.log(`notAfter: ${result.notAfter || '-'}`);
			scheduleContainerRestart();
			return;
		}

		const result = await tlsManager.generateCert(cn, { bits, days });
		console.log(`cert.pem: ${path.join(certDir, 'cert.pem')}`);
		console.log(`key.pem:  ${path.join(certDir, 'key.pem')}`);
		console.log('mode:     self-signed');
		console.log(`subject:  ${result.subject || '-'}`);
		console.log(`notAfter: ${result.notAfter || '-'}`);
		scheduleContainerRestart();
		return;
	}

	if (command === 'fix-tls-perms') {
		if (rest.length > 0) {
			usage();
		}

		await tlsManager.fixPermissions();
		console.log('TLS permissions normalized');
		console.log(`dir:      ${certDir} (700)`);
		console.log(`cert.pem: ${path.join(certDir, 'cert.pem')} (644)`);
		console.log(`key.pem:  ${path.join(certDir, 'key.pem')} (600)`);
		return;
	}

	usage();
}

main().catch((error) => {
	console.error(`[daemonctl] ${error.message}`);
	process.exit(1);
});
