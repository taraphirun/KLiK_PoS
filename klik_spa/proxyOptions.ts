import fs from 'fs';
import path from 'path';

let webserver_port = 8000;
try {
	const configPath = path.resolve(__dirname, '../../../sites/common_site_config.json');
	if (fs.existsSync(configPath)) {
		const configData = fs.readFileSync(configPath, 'utf-8');
		const common_site_config = JSON.parse(configData);
		webserver_port = common_site_config.webserver_port || 8000;
	}
} catch (e) {
	// Standalone mode outside Frappe bench or invalid config
}

export default {
	'^/(app|api|assets|files|private)': {
		target: `http://127.0.0.1:${webserver_port}`,
		ws: true,
		router: function(req: any) {
			const site_name = req.headers.host.split(':')[0];
			return `http://${site_name}:${webserver_port}`;
		}
	}
};

