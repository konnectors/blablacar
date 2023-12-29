const secrets = JSON.parse(process.env.COZY_PARAMETERS || '{}').secret
if (secrets && secrets.proxyUrl) {
  process.env.http_proxy = secrets.proxyUrl
  process.env.https_proxy = secrets.proxyUrl
}

const {
  BaseKonnector,
  requestFactory,
  saveBills,
  log,
  errors
} = require('cozy-konnector-libs')
let request = requestFactory({
  cheerio: true,
  // debug: true,
  jar: true,
  gzip: true,
  headers: {
    'user-agent':
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:62.0) Gecko/20100101 Firefox/62.0',
    'x-locale': 'fr_FR',
    'x-client': 'SPA',
    'x-currency': 'EUR',
    origin: 'https://www.blablacar.fr',
    'accept-language': 'fr_FR',
    'content-type': 'application/json',
    referer: 'https://www.blablacar.fr/login/email',
    accept: 'application/json',
    authority: 'www.blablacar.fr',
    'cache-control': 'no-cache',
    pragma: 'no-cache'
  }
})
const moment = require('moment')
moment.locale('fr')
const pdf = require('pdfjs')
const helveticaFont = require('pdfjs/font/Helvetica')
const helveticaBoldFont = require('pdfjs/font/Helvetica-Bold')

const baseUrl = 'https://www.blablacar.fr'
const loginUrl = baseUrl + '/secure-token'
const paymentsUrl = baseUrl + '/dashboard/account/payments-done'

module.exports = new BaseKonnector(start)

function start(fields) {
  log('info', 'Authenticating ...')
  return authenticate(fields.email, fields.password)
    .then(getHistory)
    .then(list => getDatas(list))
    .then(bills =>
      saveBills(bills, fields, {
        identifiers: ['blablacar'],
        contentType: 'application/pdf'
      })
    )
}

async function getDatas(list) {
  log('Getting datas and generating pdfs...')
  const bills = []
  for (let billInfo of list) {
    const date = moment(billInfo['date'], 'L')
    const $ = await request(baseUrl + billInfo['link'])
    const json = $.html()
      .split('\n')
      .filter(line => line.includes('window.INIT_STORE='))
      .pop()
      .split('</script><script>')
      .shift()
      .match(/<script>window.INIT_STORE=(.*);$/)[1]
    const info = Object.values(JSON.parse(json).entities.ridePlans).pop()

    const trip =
      info.rideItinerary.waypoints.shift().place.city +
      '-' +
      info.rideItinerary.waypoints.pop().place.city
    const start = info.rideItinerary.departureDate
      .split('T')
      .pop()
      .split(':')
      .slice(0, 2)
      .join(':')
    const places = info.seatsCount
    const tripAmount = info.displayedPrice.price.formatted_price
    const driver = info.driver.name
    let filename = date.format('YYYY-MM-DD') + '_' + trip + '_'
    if (billInfo['isRefund']) {
      filename = filename + 'Remboursement_'
    }
    filename = filename + billInfo['amount'] + '.pdf'
    log('debug', 'Generating pdf ' + filename)
    const stream = generatePdf(
      trip,
      billInfo['date'],
      start,
      places,
      tripAmount,
      driver,
      billInfo['link'],
      billInfo['isRefund'],
      billInfo['amount']
    )
    bills.push({
      filestream: stream,
      filename: filename,
      vendor: 'BlaBlacar',
      amount: parseFloat(billInfo['amount'].replace('€', '').replace(',', '.')),
      isRefund: billInfo['isRefund'],
      date: date.toDate(),
      currency: 'EUR'
    })
  }
  return bills
}

function generatePdf(
  trip,
  date,
  start,
  places,
  tripAmount,
  driver,
  link,
  isRefund,
  amount
) {
  let title = ''
  if (isRefund) {
    title = 'Informations de remboursement de voyage Blablacar.fr'
  } else {
    title = 'Informations de voyage Blablacar.fr'
  }
  var doc = new pdf.Document({ font: helveticaFont, fontSize: 12 })
  doc
    .cell({ paddingBottom: 0.5 * pdf.cm })
    .text()
    .add(title, {
      font: helveticaBoldFont,
      fontSize: 14
    })
  addLine(doc, 'Trajet : ', trip)
  addLine(doc, 'Date : ', date)
  addLine(doc, 'Départ : ', start)
  addLine(doc, 'Prix : ', tripAmount)
  if (isRefund) {
    addLine(doc, 'Remboursement : ', amount)
  }
  addLine(doc, 'Passagers : ', places)
  addLine(doc, 'Conducteur : ', driver)
  doc
    .cell({ paddingBottom: 0.5 * pdf.cm })
    .text()
    .add('Données originales : ', { font: helveticaBoldFont })
    .add(baseUrl + link, { link: baseUrl + link })
  doc
    .cell({ paddingBottom: 0.5 * pdf.cm })
    .text()
    .add('Généré automatiquement par le connecteur cozy blablacar.')
  doc.end()
  return doc
}

function addLine(doc, text1, text2) {
  return doc
    .cell({ paddingBottom: 0.5 * pdf.cm })
    .text()
    .add(text1, { font: helveticaBoldFont })
    .add(text2)
}

async function getHistory() {
  log('info', 'Getting travels history...')
  let travels = []
  let $ = await request(paymentsUrl)
  log('debug', 'Parsing main page')
  travels = travels.concat(parseHistory($))
  // Crawl next webpage until we catch a not found
  let i = 2
  let again = true
  while (again) {
    try {
      $ = await request(paymentsUrl + '/' + i)
    } catch (error) {
      if (error.statusCode === 404) {
        again = false
        log('debug', 'Page ' + i + ' do not exist')
        continue
      } else throw error
    }
    log('debug', 'Page ' + i + ' found')
    travels = travels.concat(parseHistory($))
    i++
  }

  log('info', travels)
  return travels
}

function parseHistory($) {
  return Array.from(
    $('tr', 'tbody').map((index, el) => {
      const link = $(el)
        .find('a')
        .attr('href')
      const date = $(el)
        .find('td')
        .first()
        .text()
        .trim()
      const isRefund = Boolean(
        $(el)
          .find('td')
          .eq(2)
          .text()
          .match('Remboursement')
      )
      const amount = $(el)
        .find('td')
        .eq(3)
        .text()
        .replace(/\s\s+/g, '')
        .replace(/\(|\)/g, '')
      return { date: date, link: link, isRefund: isRefund, amount: amount }
    })
  )
}

async function authenticate(email, password) {
  try {
    await request.get('https://www.blablacar.fr/login/email')
    const requestJson = requestFactory({
      json: true,
      cheerio: false // No cheerio here
    })
    await requestJson.post(loginUrl, {
      body: {
        login: email,
        password: password,
        rememberMe: true,
        grant_type: 'password'
      }
    })
    log('info', 'Successfully logged in')
  } catch (err) {
    if (err.statusCode === 401) throw new Error(errors.LOGIN_FAILED)
    else if (err.statusCode === 403) throw new Error('UNEXPECTED_CAPTCHA')
    else throw err
  }
}
