const fs = require('fs/promises');
const path = require('path');
const { execFileSync } = require('child_process');

const CERT_FILE = 'cert.pem';
const KEY_FILE = 'key.pem';

class TlsManager {
	constructor(tlsDir) {
		this.tlsDir = tlsDir;
		this.certPath = path.join(tlsDir, CERT_FILE);
		this.keyPath = path.join(tlsDir, KEY_FILE);
	}

	async fixPermissions() {
		await Promise.all([
			fs.chmod(this.tlsDir, 0o700),
			fs.chmod(this.certPath, 0o644),
			fs.chmod(this.keyPath, 0o600),
		]);
	}

	async hasCert() {
		try {
			await Promise.all([fs.access(this.certPath), fs.access(this.keyPath)]);
			return true;
		} catch {
			return false;
		}
	}

	async loadCert() {
		try {
			const [cert, key] = await Promise.all([
				fs.readFile(this.certPath, 'utf8'),
				fs.readFile(this.keyPath, 'utf8'),
			]);
			return { cert, key };
		} catch {
			return null;
		}
	}

	async generateCert(commonName = 'turn.local', options = {}) {
		await fs.mkdir(this.tlsDir, { recursive: true });

		const rawBits = Number(options.bits);
		const bits = Number.isInteger(rawBits) ? rawBits : 2048;
		if (bits < 1024 || bits > 8192) {
			throw new Error('TLS key bits must be between 1024 and 8192');
		}

		const rawDays = Number(options.days);
		const days = Number.isInteger(rawDays) ? rawDays : 3650;
		if (days < 1 || days > 36500) {
			throw new Error('TLS certificate days must be between 1 and 36500');
		}

		const safeCN = String(commonName || 'turn.local')
			.replace(/[^a-zA-Z0-9._-]/g, '-')
			.slice(0, 64) || 'turn.local';

		try {
			execFileSync(
				'openssl',
				[
					'req', '-x509',
					'-newkey', `rsa:${bits}`,
					'-keyout', this.keyPath,
					'-out', this.certPath,
					'-days', String(days),
					'-nodes',
					'-subj', `/CN=${safeCN}`,
				],
				{ stdio: 'pipe' },
			);
		} catch (err) {
			const msg = err.stderr ? err.stderr.toString().trim() : err.message;
			throw new Error(`openssl not available or certificate generation failed: ${msg}`);
		}

		await this.fixPermissions();

		const info = await this.getCertInfo();
		return {
			...info,
			bits,
			days,
		};
	}

	async deleteCert() {
		try { await fs.unlink(this.certPath); } catch { /* ignore */ }
		try { await fs.unlink(this.keyPath); } catch { /* ignore */ }
	}

	async getCertInfo() {
		if (!await this.hasCert()) {
			return { enabled: false };
		}

		try {
			const output = execFileSync(
				'openssl',
				[
					'x509',
					'-in', this.certPath,
					'-noout',
					'-subject', '-enddate', '-fingerprint', '-sha256',
				],
				{ encoding: 'utf8', stdio: 'pipe' },
			);

			const info = { enabled: true };
			for (const line of output.split('\n')) {
				if (line.startsWith('subject=')) {
					info.subject = line.replace('subject=', '').trim();
				} else if (line.startsWith('notAfter=')) {
					info.notAfter = line.replace('notAfter=', '').trim();
				} else if (line.includes('Fingerprint=')) {
					info.fingerprint = line.split('=').slice(1).join('=').trim();
				}
			}
			return info;
		} catch {
			return { enabled: true };
		}
	}
}

module.exports = { TlsManager };