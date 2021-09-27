/* global artifacts, web3, contract */
require('chai')
  .use(require('bn-chai')(web3.utils.BN))
  .use(require('chai-as-promised'))
  .should()

const { toBN } = require('web3-utils')
const {
  takeSnapshot,
  revertSnapshot,
  mineBlock,
} = require('../scripts/ganacheHelper')
const Controller = require('../src/controller')
const Account = require('../src/account')
const {
  toFixedHex,
  poseidonHash2,
  unpackEncryptedMessage,
} = require('../src/utils')
const { getEncryptionPublicKey } = require('eth-sig-util')
const ERC20Mock = artifacts.require('ERC20Mock')
const WERC20Mock = artifacts.require('WERC20Mock')
const PoofMintableLendable = artifacts.require('PoofMintableLendable')
const DepositVerifier = artifacts.require('DepositMiniVerifier')
const WithdrawVerifier = artifacts.require('WithdrawMiniVerifier')
const TreeUpdateVerifier = artifacts.require('TreeUpdateMiniVerifier')
const MerkleTree = require('fixed-merkle-tree')

// Set time to beginning of a second
async function timeReset() {
  const delay = 1000 - new Date().getMilliseconds()
  await new Promise((resolve) => setTimeout(resolve, delay))
  await mineBlock()
}

contract('PoofMintableLendable', (accounts) => {
  let uToken
  let dToken
  let poof
  const amount = toBN(16)
  // eslint-disable-next-line no-unused-vars
  const sender = accounts[0]
  const recipient = accounts[1]
  // eslint-disable-next-line no-unused-vars
  const levels = 3
  let snapshotId
  const AnotherWeb3 = require('web3')
  let contract
  let controller

  const emptyTree = new MerkleTree(levels, [], { hashFunction: poseidonHash2 })
  const privateKey = web3.eth.accounts.create().privateKey.slice(2)
  const publicKey = getEncryptionPublicKey(privateKey)

  before(async () => {
    const depositVerifier = await DepositVerifier.new()
    const withdrawVerifier = await WithdrawVerifier.new()
    const treeUpdateVerifier = await TreeUpdateVerifier.new()
    uToken = await ERC20Mock.new()
    dToken = await WERC20Mock.new(uToken.address)
    poof = await PoofMintableLendable.new(
      'Poof ibCUSD',
      'pibCUSD',
      dToken.address,
      [
        depositVerifier.address,
        withdrawVerifier.address,
        treeUpdateVerifier.address,
      ],
      toFixedHex(emptyTree.root()),
    )
    // Approve 100 deposits. 100 is arbitrary and is just meant to max approve
    await uToken.approve(poof.address, amount.mul(toBN(100)))

    const anotherWeb3 = new AnotherWeb3(web3.currentProvider)
    contract = new anotherWeb3.eth.Contract(poof.abi, poof.address)
    controller = new Controller({
      contract,
      merkleTreeHeight: levels,
    })
    snapshotId = await takeSnapshot()
  })

  beforeEach(async () => {
    await timeReset()
  })

  describe('#deposit', () => {
    it('should work', async () => {
      const zeroAccount = new Account()
      const accountCount = await poof.accountCount()

      zeroAccount.amount.should.be.eq.BN(toBN(0))

      const { proof, args, account } = await controller.deposit({
        account: zeroAccount,
        publicKey,
        amount,
      })
      const balanceBefore = await uToken.balanceOf(sender)
      const { logs } = await poof.deposit(proof, args)
      const balanceAfter = await uToken.balanceOf(sender)
      balanceBefore.should.be.eq.BN(balanceAfter.add(amount.div(toBN(2)))) // debtToken only takes half

      logs[0].event.should.be.equal('NewAccount')
      logs[0].args.commitment.should.be.equal(toFixedHex(account.commitment))
      logs[0].args.index.should.be.eq.BN(accountCount)

      logs[0].args.nullifier.should.be.equal(
        toFixedHex(zeroAccount.nullifierHash),
      )

      const encryptedAccount = logs[0].args.encryptedAccount
      const account2 = Account.decrypt(
        privateKey,
        unpackEncryptedMessage(encryptedAccount),
      )
      account.amount.should.be.eq.BN(account2.amount)
      account.secret.should.be.eq.BN(account2.secret)
      account.nullifier.should.be.eq.BN(account2.nullifier)
      account.commitment.should.be.eq.BN(account2.commitment)

      const accountCountAfter = await poof.accountCount()
      accountCountAfter.should.be.eq.BN(accountCount.add(toBN(1)))
      const rootAfter = await poof.getLastAccountRoot()
      rootAfter.should.be.equal(args.account.outputRoot)
      const accountNullifierAfter = await poof.accountNullifiers(
        toFixedHex(zeroAccount.nullifierHash),
      )
      accountNullifierAfter.should.be.true

      account.amount.should.be.eq.BN(amount)
    })
  })

  describe('#withdraw', () => {
    let proof, args, account

    beforeEach(async () => {
      ;({ proof, args, account } = await controller.deposit({
        account: new Account(),
        publicKey,
        amount,
      }))
      await poof.deposit(proof, args)
    })

    it('should work', async () => {
      const accountNullifierBefore = await poof.accountNullifiers(
        toFixedHex(account.nullifierHash),
      )
      accountNullifierBefore.should.be.false
      const accountCount = await poof.accountCount()
      const withdrawSnark = await controller.withdraw({
        account,
        amount,
        recipient,
        publicKey,
      })
      await timeReset()
      const balanceBefore = await uToken.balanceOf(recipient)
      const { logs } = await poof.withdraw(
        withdrawSnark.proof,
        withdrawSnark.args,
      )
      const balanceAfter = await uToken.balanceOf(recipient)
      balanceAfter.should.be.eq.BN(balanceBefore.add(amount.div(toBN(2)))) // Debt token only returns half
      const accountCountAfter = await poof.accountCount()
      accountCountAfter.should.be.eq.BN(accountCount.add(toBN(1)))
      const rootAfter = await poof.getLastAccountRoot()
      rootAfter.should.be.equal(withdrawSnark.args.account.outputRoot)
      const accountNullifierAfter = await poof.accountNullifiers(
        toFixedHex(account.nullifierHash),
      )
      accountNullifierAfter.should.be.true
      logs[0].event.should.be.equal('NewAccount')
      logs[0].args.commitment.should.be.equal(
        toFixedHex(withdrawSnark.account.commitment),
      )
      logs[0].args.index.should.be.eq.BN(accountCount)
      logs[0].args.nullifier.should.be.equal(toFixedHex(account.nullifierHash))
      const encryptedAccount = logs[0].args.encryptedAccount
      const account2 = Account.decrypt(
        privateKey,
        unpackEncryptedMessage(encryptedAccount),
      )
      withdrawSnark.account.amount.should.be.eq.BN(account2.amount)
      withdrawSnark.account.secret.should.be.eq.BN(account2.secret)
      withdrawSnark.account.nullifier.should.be.eq.BN(account2.nullifier)
      withdrawSnark.account.commitment.should.be.eq.BN(account2.commitment)
    })
  })

  describe('#mint and #burn', () => {
    let proof, args, account

    beforeEach(async () => {
      ;({ proof, args, account } = await controller.deposit({
        account: new Account(),
        publicKey,
        amount,
      }))
      await poof.deposit(proof, args)
    })

    it('should work', async () => {
      const mintSnark = await controller.withdraw({
        account,
        amount,
        recipient: sender,
        publicKey,
        operation: 2,
      })
      await timeReset()

      // Mint
      let balanceBefore = await poof.balanceOf(sender)
      balanceBefore.should.be.eq.BN(0)
      await poof.mint(mintSnark.proof, mintSnark.args)
      let balanceAfter = await poof.balanceOf(sender)
      balanceAfter.should.be.eq.BN(balanceBefore.add(amount))

      const burnSnark = await controller.deposit({
        account: mintSnark.account,
        amount,
        publicKey,
        operation: 3,
      })
      await timeReset()

      // Burn
      balanceBefore = await poof.balanceOf(sender)
      await poof.burn(burnSnark.proof, burnSnark.args)
      balanceAfter = await poof.balanceOf(sender)
      balanceAfter.should.be.eq.BN(0)
      balanceBefore.should.be.eq.BN(balanceAfter.add(amount))
    })
  })

  afterEach(async () => {
    await revertSnapshot(snapshotId.result)
    // eslint-disable-next-line require-atomic-updates
    snapshotId = await takeSnapshot()
  })
})
