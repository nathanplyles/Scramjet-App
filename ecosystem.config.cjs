module.exports = {
  apps: [{
    name: 'oblivion',
    script: 'src/index.js',
    env: {
      PORT: 8080,
      COOKIES_PATH: '/home/ubuntu/cookies.txt'
    }
  }]
}
