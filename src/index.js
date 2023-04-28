const { app, BrowserWindow } = require('electron')
const path = require('path')

function createWindow () {
    const win = new BrowserWindow({
        width: 1680,
        height: 1050,
        webPreferences: {
            preload: path.join(__dirname, 'src', 'scripts', 'script.js')
        }
    })

    win.loadFile(path.join('src', 'public', 'index.html'));
}

app.whenReady().then(() => {
    createWindow()

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow()
        }
    })
})

app.on('window-all-closed', () => {
    app.exit(0)
})