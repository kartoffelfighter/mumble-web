import 'stream-browserify' // see https://github.com/ericgundrum/pouch-websocket-sync-example/commit/2a4437b013092cc7b2cd84cf1499172c84a963a3
import 'subworkers' // polyfill for https://bugs.chromium.org/p/chromium/issues/detail?id=31666
import url from 'url'
import ByteBuffer from 'bytebuffer'
import MumbleClient from 'mumble-client'
import WorkerBasedMumbleConnector from './worker-client'
import BufferQueueNode from 'web-audio-buffer-queue'
import audioContext from 'audio-context'
import ko from 'knockout'
import _dompurify from 'dompurify'
import keyboardjs from 'keyboardjs'

import { ContinuousVoiceHandler, PushToTalkVoiceHandler, VADVoiceHandler, initVoice } from './voice'

const dompurify = _dompurify(window)

function sanitize (html) {
  return dompurify.sanitize(html, {
    ALLOWED_TAGS: ['br', 'b', 'i', 'u', 'a', 'span', 'p']
  })
}

function openContextMenu (event, contextMenu, target) {
  contextMenu.posX(event.clientX)
  contextMenu.posY(event.clientY)
  contextMenu.target(target)

  const closeListener = (event) => {
    // Always close, no matter where they clicked
    setTimeout(() => { // delay to allow click to be actually processed
      contextMenu.target(null)
      unregister()
    })
  }
  const unregister = () => document.removeEventListener('click', closeListener)
  document.addEventListener('click', closeListener)

  event.stopPropagation()
  event.preventDefault()
}

// GUI

function ContextMenu () {
  var self = this
  self.posX = ko.observable()
  self.posY = ko.observable()
  self.target = ko.observable()
}

function ConnectDialog () {
  var self = this
  self.address = ko.observable('')
  self.port = ko.observable('')
  self.token = ko.observable('')
  self.username = ko.observable('')
  self.password = ko.observable('')
  self.channelName = ko.observable('')
  self.joinOnly = ko.observable(false)
  self.visible = ko.observable(true)
  self.show = self.visible.bind(self.visible, true)
  self.hide = self.visible.bind(self.visible, false)
  self.connect = function () {
    self.hide()
    ui.connect(self.username(), self.address(), self.port(), self.token(), self.password(), self.channelName())
  }
}

function ConnectErrorDialog (connectDialog) {
  var self = this
  self.type = ko.observable(0)
  self.reason = ko.observable('')
  self.username = connectDialog.username
  self.password = connectDialog.password
  self.joinOnly = connectDialog.joinOnly
  self.visible = ko.observable(false)
  self.show = self.visible.bind(self.visible, true)
  self.hide = self.visible.bind(self.visible, false)
  self.connect = () => {
    self.hide()
    connectDialog.connect()
  }
}

class ConnectionInfo {
  constructor (ui) {
    this._ui = ui
    this.visible = ko.observable(false)
    this.serverVersion = ko.observable()
    this.latencyMs = ko.observable(NaN)
    this.latencyDeviation = ko.observable(NaN)
    this.remoteHost = ko.observable()
    this.remotePort = ko.observable()
    this.maxBitrate = ko.observable(NaN)
    this.currentBitrate = ko.observable(NaN)
    this.maxBandwidth = ko.observable(NaN)
    this.currentBandwidth = ko.observable(NaN)
    this.codec = ko.observable()

    this.show = () => {
      if (!ui.thisUser()) return
      this.update()
      this.visible(true)
    }
    this.hide = () => this.visible(false)
  }

  update () {
    let client = this._ui.client

    this.serverVersion(client.serverVersion)

    let dataStats = client.dataStats
    if (dataStats) {
      this.latencyMs(dataStats.mean)
      this.latencyDeviation(Math.sqrt(dataStats.variance))
    }
    this.remoteHost(this._ui.remoteHost())
    this.remotePort(this._ui.remotePort())

    let spp = this._ui.settings.samplesPerPacket
    let maxBitrate = client.getMaxBitrate(spp, false)
    let maxBandwidth = client.maxBandwidth
    let actualBitrate = client.getActualBitrate(spp, false)
    let actualBandwidth = MumbleClient.calcEnforcableBandwidth(actualBitrate, spp, false)
    this.maxBitrate(maxBitrate)
    this.currentBitrate(actualBitrate)
    this.maxBandwidth(maxBandwidth)
    this.currentBandwidth(actualBandwidth)
    this.codec('Opus') // only one supported for sending
  }
}

function CommentDialog () {
  var self = this
  self.visible = ko.observable(false)
  self.show = function () {
    self.visible(true)
  }
}

class SettingsDialog {
  constructor (settings) {
    this.voiceMode = ko.observable(settings.voiceMode)
    this.pttKey = ko.observable(settings.pttKey)
    this.pttKeyDisplay = ko.observable(settings.pttKey)
    this.vadLevel = ko.observable(settings.vadLevel)
    this.testVadLevel = ko.observable(0)
    this.testVadActive = ko.observable(false)
    this.showAvatars = ko.observable(settings.showAvatars())
    this.userCountInChannelName = ko.observable(settings.userCountInChannelName())
    // Need to wrap this in a pureComputed to make sure it's always numeric
    let audioBitrate = ko.observable(settings.audioBitrate)
    this.audioBitrate = ko.pureComputed({
      read: audioBitrate,
      write: (value) => audioBitrate(Number(value))
    })
    this.samplesPerPacket = ko.observable(settings.samplesPerPacket)
    this.msPerPacket = ko.pureComputed({
      read: () => this.samplesPerPacket() / 48,
      write: (value) => this.samplesPerPacket(value * 48)
    })

    this._setupTestVad()
    this.vadLevel.subscribe(() => this._setupTestVad())
  }

  _setupTestVad () {
    if (this._testVad) {
      this._testVad.end()
    }
    let dummySettings = new Settings({})
    this.applyTo(dummySettings)
    this._testVad = new VADVoiceHandler(null, dummySettings)
    this._testVad.on('started_talking', () => this.testVadActive(true))
                 .on('stopped_talking', () => this.testVadActive(false))
                 .on('level', level => this.testVadLevel(level))
    testVoiceHandler = this._testVad
  }

  applyTo (settings) {
    settings.voiceMode = this.voiceMode()
    settings.pttKey = this.pttKey()
    settings.vadLevel = this.vadLevel()
    settings.showAvatars(this.showAvatars())
    settings.userCountInChannelName(this.userCountInChannelName())
    settings.audioBitrate = this.audioBitrate()
    settings.samplesPerPacket = this.samplesPerPacket()
  }

  end () {
    this._testVad.end()
    testVoiceHandler = null
  }

  recordPttKey () {
    var combo = []
    const keydown = e => {
      combo = e.pressedKeys
      let comboStr = combo.join(' + ')
      this.pttKeyDisplay('> ' + comboStr + ' <')
    }
    const keyup = () => {
      keyboardjs.unbind('', keydown, keyup)
      let comboStr = combo.join(' + ')
      if (comboStr) {
        this.pttKey(comboStr).pttKeyDisplay(comboStr)
      } else {
        this.pttKeyDisplay(this.pttKey())
      }
    }
    keyboardjs.bind('', keydown, keyup)
    this.pttKeyDisplay('> ? <')
  }

  totalBandwidth () {
    return MumbleClient.calcEnforcableBandwidth(
      this.audioBitrate(),
      this.samplesPerPacket(),
      true
    )
  }

  positionBandwidth () {
    return this.totalBandwidth() - MumbleClient.calcEnforcableBandwidth(
      this.audioBitrate(),
      this.samplesPerPacket(),
      false
    )
  }

  overheadBandwidth () {
    return MumbleClient.calcEnforcableBandwidth(
      0,
      this.samplesPerPacket(),
      false
    )
  }
}

class Settings {
  constructor (defaults) {
    const load = key => window.localStorage.getItem('mumble.' + key)
    this.voiceMode = load('voiceMode') || defaults.voiceMode
    this.pttKey = load('pttKey') || defaults.pttKey
    this.vadLevel = load('vadLevel') || defaults.vadLevel
    this.toolbarVertical = load('toolbarVertical') || defaults.toolbarVertical
    this.showAvatars = ko.observable(load('showAvatars') || defaults.showAvatars)
    this.userCountInChannelName = ko.observable(load('userCountInChannelName') || defaults.userCountInChannelName)
    this.audioBitrate = Number(load('audioBitrate')) || defaults.audioBitrate
    this.samplesPerPacket = Number(load('samplesPerPacket')) || defaults.samplesPerPacket
  }

  save () {
    const save = (key, val) => window.localStorage.setItem('mumble.' + key, val)
    save('voiceMode', this.voiceMode)
    save('pttKey', this.pttKey)
    save('vadLevel', this.vadLevel)
    save('toolbarVertical', this.toolbarVertical)
    save('showAvatars', this.showAvatars())
    save('userCountInChannelName', this.userCountInChannelName())
    save('audioBitrate', this.audioBitrate)
    save('samplesPerPacket', this.samplesPerPacket)
  }
}

class GlobalBindings {
  constructor (config) {
    this.config = config
    this.settings = new Settings(config.settings)
    this.connector = new WorkerBasedMumbleConnector()
    this.client = null
    this.userContextMenu = new ContextMenu()
    this.channelContextMenu = new ContextMenu()
    this.connectDialog = new ConnectDialog()
    this.connectErrorDialog = new ConnectErrorDialog(this.connectDialog)
    this.connectionInfo = new ConnectionInfo(this)
    this.commentDialog = new CommentDialog()
    this.settingsDialog = ko.observable()
    this.minimalView = ko.observable(false)
    this.log = ko.observableArray()
    this.remoteHost = ko.observable()
    this.remotePort = ko.observable()
    this.thisUser = ko.observable()
    this.root = ko.observable()
    this.avatarView = ko.observable()
    this.messageBox = ko.observable('')
    this.toolbarHorizontal = ko.observable(!this.settings.toolbarVertical)
    this.selected = ko.observable()
    this.selfMute = ko.observable()
    this.selfDeaf = ko.observable()

    this.selfMute.subscribe(mute => {
      if (voiceHandler) {
        voiceHandler.setMute(mute)
      }
    })

    this.toggleToolbarOrientation = () => {
      this.toolbarHorizontal(!this.toolbarHorizontal())
      this.settings.toolbarVertical = !this.toolbarHorizontal()
      this.settings.save()
    }

    this.select = element => {
      this.selected(element)
    }

    this.openSettings = () => {
      this.settingsDialog(new SettingsDialog(this.settings))
    }

    this.applySettings = () => {
      const settingsDialog = this.settingsDialog()

      settingsDialog.applyTo(this.settings)

      this._updateVoiceHandler()

      this.settings.save()
      this.closeSettings()
    }

    this.closeSettings = () => {
      if (this.settingsDialog()) {
        this.settingsDialog().end()
      }
      this.settingsDialog(null)
    }

    this.getTimeString = () => {
      return '[' + new Date().toLocaleTimeString('en-US') + ']'
    }

    this.connect = (username, host, port, token, password, channelName = "") => {
      this.resetClient()

      this.remoteHost(host)
      this.remotePort(port)

      log('Connecting to server ', host)

      // Note: This call needs to be delayed until the user has interacted with
      // the page in some way (which at this point they have), see: https://goo.gl/7K7WLu
      this.connector.setSampleRate(audioContext().sampleRate)

      // TODO: token
      this.connector.connect(`wss://${host}:${port}`, {
        username: username,
        password: password
      }).done(client => {
        log('Connected!')

        this.client = client
        // Prepare for connection errors
        client.on('error', (err) => {
          log('Connection error:', err)
          this.resetClient()
        })

        // Make sure we stay open if we're running as Matrix widget
        window.matrixWidget.setAlwaysOnScreen(true)

        // Register all channels, recursively
        const registerChannel = (channel, channelPath) => {
          this._newChannel(channel)
          if(channelPath === channelName) {
            client.self.setChannel(channel)
          }
          channel.children.forEach(ch => registerChannel(ch, channelPath+"/"+ch.name))
        }
        registerChannel(client.root, "")

        // Register all users
        client.users.forEach(user => this._newUser(user))

        // Register future channels
        client.on('newChannel', channel => this._newChannel(channel))
        // Register future users
        client.on('newUser', user => this._newUser(user))

        // Handle messages
        client.on('message', (sender, message, users, channels, trees) => {
          sender = sender || { __ui: 'Server' }
          ui.log.push({
            type: 'chat-message',
            user: sender.__ui,
            channel: channels.length > 0,
            message: sanitize(message)
          })
        })

        // Set own user and root channel
        this.thisUser(client.self.__ui)
        this.root(client.root.__ui)
        // Upate linked channels
        this._updateLinks()
        // Log welcome message
        if (client.welcomeMessage) {
          this.log.push({
            type: 'welcome-message',
            message: sanitize(client.welcomeMessage)
          })
        }

        // Startup audio input processing
        this._updateVoiceHandler()
        // Tell server our mute/deaf state (if necessary)
        if (this.selfDeaf()) {
          this.client.setSelfDeaf(true)
        } else if (this.selfMute()) {
          this.client.setSelfMute(true)
        }
      }, err => {
        if (err.$type && err.$type.name === 'Reject') {
          this.connectErrorDialog.type(err.type)
          this.connectErrorDialog.reason(err.reason)
          this.connectErrorDialog.show()
        } else {
          log('Connection error:', err)
        }
      })
    }

    this._newUser = user => {
      const simpleProperties = {
        uniqueId: 'uid',
        username: 'name',
        mute: 'mute',
        deaf: 'deaf',
        suppress: 'suppress',
        selfMute: 'selfMute',
        selfDeaf: 'selfDeaf',
        texture: 'rawTexture',
        textureHash: 'textureHash',
        comment: 'comment'
      }
      var ui = user.__ui = {
        model: user,
        talking: ko.observable('off'),
        channel: ko.observable()
      }
      ui.texture = ko.pureComputed(() => {
        let raw = ui.rawTexture()
        if (!raw || raw.offset >= raw.limit) return null
        return 'data:image/*;base64,' + ByteBuffer.wrap(raw).toBase64()
      })
      ui.show_avatar = () => {
        let setting = this.settings.showAvatars()
        switch (setting) {
          case 'always':
            break
          case 'own_channel':
            if (this.thisUser().channel() !== ui.channel()) return false
            break
          case 'linked_channel':
            if (!ui.channel().linked()) return false
            break
          case 'minimal_only':
            if (!this.minimalView()) return false
            if (this.thisUser().channel() !== ui.channel()) return false
            break
          case 'never':
          default: return false
        }
        if (!ui.texture()) {
          if (ui.textureHash()) {
            // The user has an avatar set but it's of sufficient size to not be
            // included by default, so we need to fetch it explicitly now.
            // mumble-client should make sure we only send one request per hash
            user.requestTexture()
          }
          return false
        }
        return true
      }
      ui.openContextMenu = (_, event) => openContextMenu(event, this.userContextMenu, ui)
      ui.canChangeMute = () => {
        return false // TODO check for perms and implement
      }
      ui.canChangeDeafen = () => {
        return false // TODO check for perms and implement
      }
      ui.canChangePrioritySpeaker = () => {
        return false // TODO check for perms and implement
      }
      ui.canLocalMute = () => {
        return false // TODO implement local mute
        // return this.thisUser() !== ui
      }
      ui.canIgnoreMessages = () => {
        return false // TODO implement ignore messages
        // return this.thisUser() !== ui
      }
      ui.canChangeComment = () => {
        return false // TODO implement changing of comments
        // return this.thisUser() === ui // TODO check for perms
      }
      ui.canChangeAvatar = () => {
        return this.thisUser() === ui // TODO check for perms
      }
      ui.toggleMute = () => {
        if (ui.selfMute()) {
          this.requestUnmute(ui)
        } else {
          this.requestMute(ui)
        }
      }
      ui.toggleDeaf = () => {
        if (ui.selfDeaf()) {
          this.requestUndeaf(ui)
        } else {
          this.requestDeaf(ui)
        }
      }
      ui.viewAvatar = () => {
        this.avatarView(ui.texture())
      }
      ui.changeAvatar = () => {
        let input = document.createElement('input')
        input.type = 'file'
        input.addEventListener('change', () => {
          let reader = new window.FileReader()
          reader.onload = () => {
            this.client.setSelfTexture(reader.result)
          }
          reader.readAsArrayBuffer(input.files[0])
        })
        input.click()
      }
      ui.removeAvatar = () => {
        user.clearTexture()
      }
      Object.entries(simpleProperties).forEach(key => {
        ui[key[1]] = ko.observable(user[key[0]])
      })
      ui.state = ko.pureComputed(userToState, ui)
      if (user.channel) {
        ui.channel(user.channel.__ui)
        ui.channel().users.push(ui)
        ui.channel().users.sort(compareUsers)
      }

      user.on('update', (actor, properties) => {
        Object.entries(simpleProperties).forEach(key => {
          if (properties[key[0]] !== undefined) {
            ui[key[1]](properties[key[0]])
          }
        })
        if (properties.channel !== undefined) {
          if (ui.channel()) {
            ui.channel().users.remove(ui)
          }
          ui.channel(properties.channel.__ui)
          ui.channel().users.push(ui)
          ui.channel().users.sort(compareUsers)
          this._updateLinks()
        }
        if (properties.textureHash !== undefined) {
          // Invalidate avatar texture when its hash has changed
          // If the avatar is still visible, this will trigger a fetch of the new one.
          ui.rawTexture(null)
        }
      }).on('remove', () => {
        if (ui.channel()) {
          ui.channel().users.remove(ui)
        }
      }).on('voice', stream => {
        console.log(`User ${user.username} started takling`)
        var userNode = new BufferQueueNode({
          audioContext: audioContext()
        })
        userNode.connect(audioContext().destination)

        stream.on('data', data => {
          if (data.target === 'normal') {
            ui.talking('on')
          } else if (data.target === 'shout') {
            ui.talking('shout')
          } else if (data.target === 'whisper') {
            ui.talking('whisper')
          }
          userNode.write(data.buffer)
        }).on('end', () => {
          console.log(`User ${user.username} stopped takling`)
          ui.talking('off')
          userNode.end()
        })
      })
    }

    this._newChannel = channel => {
      const simpleProperties = {
        position: 'position',
        name: 'name',
        description: 'description'
      }
      var ui = channel.__ui = {
        model: channel,
        expanded: ko.observable(true),
        parent: ko.observable(),
        channels: ko.observableArray(),
        users: ko.observableArray(),
        linked: ko.observable(false)
      }
      ui.userCount = () => {
        return ui.channels().reduce((acc, c) => acc + c.userCount(), ui.users().length)
      }
      ui.openContextMenu = (_, event) => openContextMenu(event, this.channelContextMenu, ui)
      ui.canJoin = () => {
        return true // TODO check for perms
      }
      ui.canAdd = () => {
        return false // TODO check for perms and implement
      }
      ui.canEdit = () => {
        return false // TODO check for perms and implement
      }
      ui.canRemove = () => {
        return false // TODO check for perms and implement
      }
      ui.canLink = () => {
        return false // TODO check for perms and implement
      }
      ui.canUnlink = () => {
        return false // TODO check for perms and implement
      }
      ui.canSendMessage = () => {
        return false // TODO check for perms and implement
      }
      Object.entries(simpleProperties).forEach(key => {
        ui[key[1]] = ko.observable(channel[key[0]])
      })
      if (channel.parent) {
        ui.parent(channel.parent.__ui)
        ui.parent().channels.push(ui)
        ui.parent().channels.sort(compareChannels)
      }
      this._updateLinks()

      channel.on('update', properties => {
        Object.entries(simpleProperties).forEach(key => {
          if (properties[key[0]] !== undefined) {
            ui[key[1]](properties[key[0]])
          }
        })
        if (properties.parent !== undefined) {
          if (ui.parent()) {
            ui.parent().channel.remove(ui)
          }
          ui.parent(properties.parent.__ui)
          ui.parent().channels.push(ui)
          ui.parent().channels.sort(compareChannels)
        }
        if (properties.links !== undefined) {
          this._updateLinks()
        }
      }).on('remove', () => {
        if (ui.parent()) {
          ui.parent().channels.remove(ui)
        }
        this._updateLinks()
      })
    }

    this.resetClient = () => {
      if (this.client) {
        this.client.disconnect()
      }
      this.client = null
      this.selected(null).root(null).thisUser(null)
    }

    this.connected = () => this.thisUser() != null

    this._updateVoiceHandler = () => {
      if (!this.client) {
        return
      }
      if (voiceHandler) {
        voiceHandler.end()
        voiceHandler = null
      }
      let mode = this.settings.voiceMode
      if (mode === 'cont') {
        voiceHandler = new ContinuousVoiceHandler(this.client, this.settings)
      } else if (mode === 'ptt') {
        voiceHandler = new PushToTalkVoiceHandler(this.client, this.settings)
      } else if (mode === 'vad') {
        voiceHandler = new VADVoiceHandler(this.client, this.settings)
      } else {
        log('Unknown voice mode:', mode)
        return
      }
      voiceHandler.on('started_talking', () => {
        if (this.thisUser()) {
          this.thisUser().talking('on')
        }
      })
      voiceHandler.on('stopped_talking', () => {
        if (this.thisUser()) {
          this.thisUser().talking('off')
        }
      })
      if (this.selfMute()) {
        voiceHandler.setMute(true)
      }

      this.client.setAudioQuality(
        this.settings.audioBitrate,
        this.settings.samplesPerPacket
      )
    }

    this.messageBoxHint = ko.pureComputed(() => {
      if (!this.thisUser()) {
        return '' // Not yet connected
      }
      var target = this.selected()
      if (!target) {
        target = this.thisUser()
      }
      if (target === this.thisUser()) {
        target = target.channel()
      }
      if (target.users) { // Channel
        return "Type message to channel '" + target.name() + "' here"
      } else { // User
        return "Type message to user '" + target.name() + "' here"
      }
    })

    this.submitMessageBox = () => {
      this.sendMessage(this.selected(), this.messageBox())
      this.messageBox('')
    }

    this.sendMessage = (target, message) => {
      if (this.connected()) {
        // If no target is selected, choose our own user
        if (!target) {
          target = this.thisUser()
        }
        // If target is our own user, send to our channel
        if (target === this.thisUser()) {
          target = target.channel()
        }
        // Send message
        target.model.sendMessage(message)
        if (target.users) { // Channel
          this.log.push({
            type: 'chat-message-self',
            message: sanitize(message),
            channel: target
          })
        } else { // User
          this.log.push({
            type: 'chat-message-self',
            message: sanitize(message),
            user: target
          })
        }
      }
    }

    this.requestMove = (user, channel) => {
      if (this.connected()) {
        user.model.setChannel(channel.model)
      }
    }

    this.requestMute = user => {
      if (user === this.thisUser()) {
        this.selfMute(true)
      }
      if (this.connected()) {
        if (user === this.thisUser()) {
          this.client.setSelfMute(true)
        } else {
          user.model.setMute(true)
        }
      }
    }

    this.requestDeaf = user => {
      if (user === this.thisUser()) {
        this.selfMute(true)
        this.selfDeaf(true)
      }
      if (this.connected()) {
        if (user === this.thisUser()) {
          this.client.setSelfDeaf(true)
        } else {
          user.model.setDeaf(true)
        }
      }
    }

    this.requestUnmute = user => {
      if (user === this.thisUser()) {
        this.selfMute(false)
        this.selfDeaf(false)
      }
      if (this.connected()) {
        if (user === this.thisUser()) {
          this.client.setSelfMute(false)
        } else {
          user.model.setMute(false)
        }
      }
    }

    this.requestUndeaf = user => {
      if (user === this.thisUser()) {
        this.selfDeaf(false)
      }
      if (this.connected()) {
        if (user === this.thisUser()) {
          this.client.setSelfDeaf(false)
        } else {
          user.model.setDeaf(false)
        }
      }
    }

    this._updateLinks = () => {
      if (!this.thisUser()) {
        return
      }

      var allChannels = getAllChannels(this.root(), [])
      var ownChannel = this.thisUser().channel().model
      var allLinked = findLinks(ownChannel, [])
      allChannels.forEach(channel => {
        channel.linked(allLinked.indexOf(channel.model) !== -1)
      })

      function findLinks (channel, knownLinks) {
        knownLinks.push(channel)
        channel.links.forEach(next => {
          if (next && knownLinks.indexOf(next) === -1) {
            findLinks(next, knownLinks)
          }
        })
        allChannels.map(c => c.model).forEach(next => {
          if (next && knownLinks.indexOf(next) === -1 && next.links.indexOf(channel) !== -1) {
            findLinks(next, knownLinks)
          }
        })
        return knownLinks
      }

      function getAllChannels (channel, channels) {
        channels.push(channel)
        channel.channels().forEach(next => getAllChannels(next, channels))
        return channels
      }
    }

    this.openSourceCode = () => {
      var homepage = require('../package.json').homepage
      window.open(homepage, '_blank').focus()
    }

    this.updateSize = () => {
      this.minimalView(window.innerWidth < 320)
      if (this.minimalView()) {
        this.toolbarHorizontal(window.innerWidth < window.innerHeight)
      } else {
        this.toolbarHorizontal(!this.settings.toolbarVertical)
      }
    }
  }
}
var ui = new GlobalBindings(window.mumbleWebConfig)

// Used only for debugging
window.mumbleUi = ui

window.onload = function () {
  var queryParams = url.parse(document.location.href, true).query
  queryParams = Object.assign({}, window.mumbleWebConfig.defaults, queryParams)
  var useJoinDialog = queryParams.joinDialog
  if (queryParams.matrix) {
    useJoinDialog = true
  }
  if (queryParams.address) {
    ui.connectDialog.address(queryParams.address)
  } else {
    useJoinDialog = false
  }
  if (queryParams.port) {
    ui.connectDialog.port(queryParams.port)
  } else {
    useJoinDialog = false
  }
  if (queryParams.token) {
    ui.connectDialog.token(queryParams.token)
  }
  if (queryParams.username) {
    ui.connectDialog.username(queryParams.username)
  } else {
    useJoinDialog = false
  }
  if (queryParams.password) {
    ui.connectDialog.password(queryParams.password)
  }
  if (queryParams.channelName) {
    ui.connectDialog.channelName(queryParams.channelName)
  }
  if (queryParams.avatarurl) {
    // Download the avatar and upload it to the mumble server when connected
    let url = queryParams.avatarurl
    console.log('Fetching avatar from', url)
    let req = new window.XMLHttpRequest()
    req.open('GET', url, true)
    req.responseType = 'arraybuffer'
    req.onload = () => {
      let upload = (avatar) => {
        if (req.response) {
          console.log('Uploading user avatar to server')
          ui.client.setSelfTexture(req.response)
        }
      }
      // On any future connections
      ui.thisUser.subscribe((thisUser) => {
        if (thisUser) {
          upload()
        }
      })
      // And the current one (if already connected)
      if (ui.thisUser()) {
        upload()
      }
    }
    req.send()
  }
  ui.connectDialog.joinOnly(useJoinDialog)
  ko.applyBindings(ui)
}

window.onresize = () => ui.updateSize()
ui.updateSize()

function log () {
  console.log.apply(console, arguments)
  var args = []
  for (var i = 0; i < arguments.length; i++) {
    args.push(arguments[i])
  }
  ui.log.push({
    type: 'generic',
    value: args.join(' ')
  })
}

function compareChannels (c1, c2) {
  if (c1.position() === c2.position()) {
    return c1.name() === c2.name() ? 0 : c1.name() < c2.name() ? -1 : 1
  }
  return c1.position() - c2.position()
}

function compareUsers (u1, u2) {
  return u1.name() === u2.name() ? 0 : u1.name() < u2.name() ? -1 : 1
}

function userToState () {
  var flags = []
  // TODO: Friend
  if (this.uid()) {
    flags.push('Authenticated')
  }
  // TODO: Priority Speaker, Recording
  if (this.mute()) {
    flags.push('Muted (server)')
  }
  if (this.deaf()) {
    flags.push('Deafened (server)')
  }
  // TODO: Local Ignore (Text messages), Local Mute
  if (this.selfMute()) {
    flags.push('Muted (self)')
  }
  if (this.selfDeaf()) {
    flags.push('Deafened (self)')
  }
  return flags.join(', ')
}

var voiceHandler
var testVoiceHandler

initVoice(data => {
  if (testVoiceHandler) {
    testVoiceHandler.write(data)
  }
  if (!ui.client) {
    if (voiceHandler) {
      voiceHandler.end()
    }
    voiceHandler = null
  } else if (voiceHandler) {
    voiceHandler.write(data)
  }
}, err => {
  log('Cannot initialize user media. Microphone will not work:', err)
})
