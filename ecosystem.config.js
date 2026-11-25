// PM2: ใช้ได้ทั้ง Linux และ Windows
//   npm install -g pm2
//   pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [
    {
      name: 'ekg-lab-viewer',
      script: 'server.js',
      node_args: '--env-file-if-exists=.env',
      cwd: __dirname,
      instances: 1, // ต้องเป็น 1 เพราะเก็บข้อมูลในไฟล์ JSON
      autorestart: true,
      max_memory_restart: '500M',
    },
  ],
};
