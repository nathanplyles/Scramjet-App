module.exports = {
  apps: [{
    name: 'oblivion',
    script: 'src/index.js',
    env: {
      PORT: 8080,
      LASTFM_API_KEY: '2a3e308ee9fc534477b372ca0b57a38e',
      CEREBRAS_API_KEY: 'csk-4te88j2ddpkxv4m66r26et8vmr2y2c2vvpddfpdvkxd8fh3v',
      GEMINI_API_KEY: 'AIzaSyBvw90UCyzo52G99RawPhBq45I_UtbDAQw',
      GROQ_API_KEY: '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',
      COOKIES_PATH: '/home/ubuntu/cookies.txt'
    }
  }]
}
