import { test, expect } from './app'

// A model's question never holds the chat up: the turn that asked finishes, the card waits, and
// one click on an answer sends it as the next message with the question quoted above it.
test('a question from the model is answered with one click and becomes the next message', async ({ rocket }) => {
  const { page } = rocket
  const message = page.getByRole('textbox', { name: 'Message', exact: true })
  await page.locator('.composer-folder').click()
  await message.fill('UI check: ask')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const card = page.getByRole('group', { name: 'Question from the model' })
  await expect(card).toContainText('Which database should the new service use?')
  await expect(card.locator('.question-option')).toHaveCount(3)
  await expect(card.locator('.question-option.is-recommended')).toContainText('Postgres')
  await expect(card.locator('.question-option.is-recommended')).toContainText('Suggested')
  // The turn that asked is over, and the composer is free: nothing waited on the answer.
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await expect(page.locator('.turn')).toHaveCount(1)
  await rocket.capture('question-card')

  await card.getByRole('button', { name: /^SQLite/ }).click()
  await expect(page.locator('.turn')).toHaveCount(2)
  const answer = page.locator('.turn').last().locator('.user-bubble')
  await expect(answer.locator('blockquote')).toHaveText('Which database should the new service use?')
  await expect(answer).toContainText('SQLite')
  // The card folds to the question and the choice, with nothing left to click.
  await expect(page.locator('.question.is-answered')).toContainText('SQLite')
  await expect(page.locator('.question-option')).toHaveCount(0)
  await rocket.capture('question-answered')
})
