import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
import waitFor, { TimeoutError } from 'p-wait-for'
const log = Minilog('ContentScript')
Minilog.enable('blablacarCCC')

const baseUrl = 'https://www.blablacar.fr'
const mailLoginUrl = 'https://www.blablacar.fr/login/email'

let personnalInfos = []
// Interception needed to retrieve personnal infos data
const fetchOriginal = window.fetch

// Remplacer la fonction fetch par une nouvelle fonction
window.fetch = async (...args) => {
  const response = await fetchOriginal(...args)
  if (typeof args[0] === 'string' && args[0].includes('/api/v2/me')) {
    await response
      .clone()
      .json()
      .then(body => {
        personnalInfos.push(body)
        return response
      })
      .catch(err => {
        // eslint-disable-next-line no-console
        console.log(err)
        return response
      })
  }
  return response
}

class BlablacarContentScript extends ContentScript {
  async navigateToLoginForm() {
    this.log('info', '🤖 navigateToLoginForm')
    await this.goto(mailLoginUrl)
    await Promise.race([
      this.waitForElementInWorker('input[name="login"]'),
      this.waitForElementInWorker('form[role="search"]')
    ])
  }

  async navigateToBaseUrl() {
    this.log('info', '🤖 navigateToBaseUrl')
    await this.goto(baseUrl)
    await Promise.race([
      this.waitForElementInWorker('a[href="/login"]'),
      this.waitForElementInWorker('#logout')
    ])
  }

  onWorkerEvent(event, payload) {
    if (event === 'loginSubmit') {
      this.log('info', 'received loginSubmit, blocking user interactions')
      this.blockWorkerInteractions()
    } else if (event === 'loginError') {
      this.log(
        'info',
        'received loginError, unblocking user interactions: ' + payload?.msg
      )
      this.unblockWorkerInteractions()
    }
  }

  async ensureAuthenticated({ account }) {
    this.log('info', '🤖 ensureAuthenticated')
    this.bridge.addEventListener('workerEvent', this.onWorkerEvent.bind(this))
    await this.navigateToBaseUrl()
    if (!account) {
      this.log('info', "No account detected, ensuring we're logged out")
      await this.ensureNotAuthenticated()
    }
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      this.log('info', 'Not authenticated')
      await this.navigateToLoginForm()
      await this.showLoginFormAndWaitForAuthentication()
    }
    const ask2FA = await this.isElementInWorker('input[inputmode="numeric"]')
    if (ask2FA) {
      await this.setWorkerState({ visible: true })
      await this.runInWorkerUntilTrue({ method: 'waitFor2FACode' })
      await this.setWorkerState({ visible: false })
    }
    this.unblockWorkerInteractions()
    return true
  }

  async ensureNotAuthenticated() {
    this.log('info', '🤖 ensureNotAuthenticated')
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      return true
    }
    await this.clickAndWait('#logout', 'a[href="/login"]')
    return true
  }

  onWorkerReady() {
    const button = document.querySelector('input[type=submit]')
    if (button) {
      button.addEventListener('click', () =>
        this.bridge.emit('workerEvent', 'loginSubmit')
      )
    }
    const error = document.querySelector('.error')
    if (error) {
      this.bridge.emit('workerEvent', 'loginError', { msg: error.innerHTML })
    }
  }

  async checkAuthenticated() {
    this.log('info', 'checkAuthenticated starts')
    const passwordField = document.querySelector('input[name="password"]')
    const loginField = document.querySelector('input[name="login"]')
    if (passwordField && loginField) {
      const userCredentials = await this.findAndSendCredentials.bind(this)(
        loginField,
        passwordField
      )
      this.log('info', "Sending user's credentials to Pilot")
      this.sendToPilot({ userCredentials })
    }

    if (document.querySelector('input[inputmode="numeric"]')) {
      this.log('info', 'Auth detected - 2FA needed')
      return true
    }

    return Boolean(document.querySelector('#logout'))
  }

  async findAndSendCredentials(loginField, passwordField) {
    this.log('info', 'findAndSendCredentials starts')
    let userLogin = loginField.value
    let userPassword = passwordField.value
    const userCredentials = {
      email: userLogin,
      password: userPassword
    }
    return userCredentials
  }

  async showLoginFormAndWaitForAuthentication() {
    this.log('info', 'showLoginFormAndWaitForAuthentication start')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({
      method: 'waitForAuthenticated'
    })
    await this.setWorkerState({ visible: false })
  }

  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite')
    await this.clickAndWait(
      'a[href="/dashboard/profile/menu"]',
      '#content-about_you'
    )
    await this.runInWorkerUntilTrue({ method: 'checkInterception' })
    await this.runInWorker('getIdentity')
    if (!this.store.userIdentity?.email) {
      throw new Error(
        'getUserDataFromWebsite: Could not find an email in user identity'
      )
    } else {
      return {
        sourceAccountIdentifier: this.store.userIdentity.email
      }
    }
  }

  async fetch() {
    this.log('info', '🤖 fetch')
    if (this.store.userCredentials) {
      await this.saveCredentials(this.store.userCredentials)
    }
    await this.saveIdentity({ contact: this.store.userIdentity })
    await this.waitForElementInWorker('[pause]')
  }

  // We cannot make any form of autoLogin, website is protecting itself from using JS to fill and validate the loginForm
  // We cannot pre-fill the form either, website is emptying all inputs if it detects it has not been filled "by hand" and verified the events sent when typing/simulating
  // We're keeping this around in case we find a way to use it later

  // async tryAutoLogin(credentials) {
  //   this.log('info', 'tryAutologin starts')
  //   await this.autoLogin(credentials)
  //   await this.runInWorkerUntilTrue({ method: 'waitForAuthenticated' })
  // }

  // async autoLogin(credentials) {
  //   this.log('info', 'autoLogin starts')
  //   await Promise.all([
  //     this.waitForElementInWorker('input[name="login"]'),
  //     this.waitForElementInWorker('input[name="password"]'),
  //     this.waitForElementInWorker('button[type="submit"]')
  //   ])
  //   await this.runInWorker('fillText', 'input[name="login"]', credentials.email)
  //   await this.runInWorker(
  //     'fillText',
  //     'input[name="password"]',
  //     credentials.password
  //   )
  //   await this.waitForElementInWorker('[pause-autoLogin]')
  //   await this.runInWorker('click', 'button[type="submit"]')
  // }

  async waitFor2FACode() {
    this.log('info', 'waitFor2FACode starts')
    await waitFor(
      () => {
        const searchForm = document.querySelector('form[role="search"]')
        if (searchForm) {
          this.log('info', 'Logged in, continue')
          return true
        } else {
          return false
        }
      },
      {
        interval: 1000,
        timeout: {
          // It has been agreed we're waiting for Infinity when a user's input is needed
          milliseconds: Infinity,
          message: new TimeoutError(
            'waitFor2FACode timed out, can be because the user never filled the code or the wanted selector is missing'
          )
        }
      }
    )
    return true
  }

  async checkInterception() {
    this.log('info', 'checkInterception starts')
    await waitFor(
      () => {
        if (personnalInfos.length > 0) {
          this.log('info', 'interception succesfull, continue')
          return true
        } else {
          return false
        }
      },
      {
        interval: 1000,
        timeout: {
          milliseconds: 10000,
          message: new TimeoutError('checkInterception timed out after 10 sec')
        }
      }
    )
    return true
  }

  async getIdentity() {
    this.log('info', 'getIdentity starts')
    const infos = personnalInfos[0]
    const email = infos.email
    const givenName = infos.firstname
    const familyName = infos.lastname
    const birthDate = infos.birthdate
    const phoneNumber = infos.phone.national_formatted_number.replace(/ /g, '')
    const userIdentity = {
      email,
      phone: [
        {
          // Here we assume it can only be a mobile number as they need to send you an sms for validation code
          type: 'mobile',
          number: phoneNumber
        }
      ],
      name: {
        givenName,
        familyName
      },
      birthDate
    }
    await this.sendToPilot({ userIdentity })
  }
}

const connector = new BlablacarContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'waitFor2FACode',
      'checkInterception',
      'getIdentity'
    ]
  })
  .catch(err => {
    log.warn(err)
  })
