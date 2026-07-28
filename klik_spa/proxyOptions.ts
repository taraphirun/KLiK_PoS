import fs from 'fs';
import path from 'path';

let webserver_port = 8000;
try {
  const configPath = path.resolve(__dirname, '../../../sites/common_site_config.json');
  if (fs.existsSync(configPath)) {
    const common_site_config = require(configPath);
    if (common_site_config.webserver_port) {
      webserver_port = common_site_config.webserver_port;
    }
  }
} catch (e) {
  console.warn("Could not load common_site_config.json, using default port 8000");
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
