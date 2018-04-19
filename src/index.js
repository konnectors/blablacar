const {
  BaseKonnector,
  requestFactory,
  saveBills,
  log,
  errors
} = require('cozy-konnector-libs')
let request = requestFactory({ cheerio: false, debug: false, jar: true })
const moment = require('moment')
moment.locale('fr')
const pdf = require('pdfjs')
const helveticaFont = new pdf.Font(require('pdfjs/font/Helvetica.json'))
const helveticaBoldFont = new pdf.Font(
  require('pdfjs/font/Helvetica-Bold.json')
)

const baseUrl = 'https://www.blablacar.fr'
const loginUrl = baseUrl + '/secure-token'
const paymentsUrl = baseUrl + '/dashboard/account/payments-done'

module.exports = new BaseKonnector(start)

function start(fields) {
  log('info', 'Authenticating ...')
  return authenticate(fields.email, fields.password)
    .then(() => {
      request = requestFactory({ cheerio: true })
    })
    .then(getHistory)
    .then(list => getDatas(list))
    .then(bills =>
      saveBills(bills, fields, {
        identifiers: 'blablacar',
        contentType: 'application/pdf'
      })
    )
}

async function getDatas(list) {
  log('Getting datas and generating pdfs...')
  const bills = []
  for (let billInfo of list) {
    const date = moment(billInfo['date'], 'L')
    $ = await request(baseUrl + billInfo['link'])
    const trip = $('h2[class=u-left]', 'section[class="main-block"]')
      .text()
      .trim()
      .replace('→', '-')
      .replace(/\s/g, '')
    const start = $('div[class=row-content]')
      .eq(1)
      .text()
      .trim()
      .replace(/\s\s+/g, ' ')
    const places = $('div[class=row-content]')
      .eq(2)
      .text()
      .trim()
    const tripAmount = $('div[class=row-content]')
      .eq(3)
      .text()
      .replace(/\s/g, '')
    const driver = $('a', 'div[class=driver-info]')
      .text()
      .trim()
      .replace(/\s\s+/g, ' ')
    let filename = date.format('YYYY-MM-DD') + '_' + trip + '_'
    if (billInfo['isRefund']) {
      filename = filename + 'Remboursement_'
    }
    filename = filename + billInfo['amount'] + '.pdf'
    log('debug', 'Generating pdf ' + filename)
    stream = generatePdf(
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
      filestream: stream._doc,
      filename: filename,
      vendor: 'BlaBlacar',
      amount: parseFloat(tripAmount.replace('€', '').replace(',', '.')),
      // TODOlucst CHECK REAL AMOUNT and SIGN
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
  travels = []
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

function authenticate(email, password) {
  return request({
    method: 'POST',
    uri: loginUrl,
    headers: {
      'content-type': 'application/json'
    },
    json: true,
    body: {
      login: email,
      password: password,
      rememberMe: true,
      grant_type: 'password'
    }
  }).catch(err => {
    if (err.statusCode === 401) throw new Error(errors.LOGIN_FAILED)
    else throw err
  })
}
