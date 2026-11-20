// Unit tests run on Hardhat's in-process network with hre.ethers (the only place ethers is used).
const { expect } = require('chai')
const { ethers } = require('hardhat')
const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers')

const FACE = ethers.parseEther('0.01')
const CAP_PCT = 10
const MAX_RESALE = (FACE * 110n) / 100n

async function deployFixture() {
  const [organiser, fan, buyer, staff, waitlisted, stranger] = await ethers.getSigners()
  const FairPass = await ethers.getContractFactory('FairPass')
  const fp = await FairPass.deploy('FairPass Ticket', 'FPASS')
  const date = Math.floor(Date.now() / 1000) + 30 * 86400
  await fp.createEvent('[Headliner] World Tour', date, FACE, 3, CAP_PCT)
  await fp.addGateStaff(staff.address)
  await fp.mintTicket(fan.address, 1) // token 1
  await fp.mintTicket(fan.address, 1) // token 2
  return { fp, organiser, fan, buyer, staff, waitlisted, stranger }
}

describe('FairPass', () => {
  describe('minting', () => {
    it('mints tickets and records the event', async () => {
      const { fp, fan } = await loadFixture(deployFixture)
      expect(await fp.ownerOf(1)).to.equal(fan.address)
      expect(await fp.ticketEvent(1)).to.equal(1n)
      expect((await fp.events(1)).minted).to.equal(2n)
    })

    it('mintTickets mints a whole quantity for one winner in one transaction', async () => {
      const { fp, buyer } = await loadFixture(deployFixture)
      await fp.createEvent('Big Night', 1, FACE, 10, CAP_PCT) // event 2
      await expect(fp.mintTickets(buyer.address, 2, 4))
        .to.emit(fp, 'TicketMinted')
        .withArgs(3, 2, buyer.address)
      for (const id of [3, 4, 5, 6]) {
        expect(await fp.ownerOf(id)).to.equal(buyer.address)
        expect(await fp.ticketEvent(id)).to.equal(2n)
      }
      expect((await fp.events(2)).minted).to.equal(4n)
      expect(await fp.balanceOf(buyer.address)).to.equal(4n)
    })

    it('mintTickets reverts past maxSupply (nothing minted) and for quantity 0', async () => {
      const { fp, buyer } = await loadFixture(deployFixture)
      await expect(fp.mintTickets(buyer.address, 1, 2)).to.be.revertedWithCustomError(fp, 'SoldOut') // 2 of 3 used
      expect((await fp.events(1)).minted).to.equal(2n)
      await expect(fp.mintTickets(buyer.address, 1, 0)).to.be.revertedWithCustomError(fp, 'InvalidQuantity')
      await fp.mintTickets(buyer.address, 1, 1)
      expect((await fp.events(1)).minted).to.equal(3n)
    })

    it('reverts minting past maxSupply', async () => {
      const { fp, fan } = await loadFixture(deployFixture)
      await fp.mintTicket(fan.address, 1) // 3 of 3
      await expect(fp.mintTicket(fan.address, 1)).to.be.revertedWithCustomError(fp, 'SoldOut')
    })

    it('only the owner can create events and mint', async () => {
      const { fp, stranger } = await loadFixture(deployFixture)
      await expect(fp.connect(stranger).mintTicket(stranger.address, 1)).to.be.revertedWithCustomError(
        fp,
        'OwnableUnauthorizedAccount',
      )
      await expect(fp.connect(stranger).createEvent('x', 1, FACE, 1, 10)).to.be.revertedWithCustomError(
        fp,
        'OwnableUnauthorizedAccount',
      )
    })

    it('reverts minting for an unknown event', async () => {
      const { fp, fan } = await loadFixture(deployFixture)
      await expect(fp.mintTicket(fan.address, 99)).to.be.revertedWithCustomError(fp, 'UnknownEvent')
    })
  })

  describe('transfer lock', () => {
    it('reverts a direct transferFrom', async () => {
      const { fp, fan, buyer } = await loadFixture(deployFixture)
      await expect(fp.connect(fan).transferFrom(fan.address, buyer.address, 1)).to.be.revertedWithCustomError(
        fp,
        'TransfersDisabled',
      )
    })

    it('reverts safeTransferFrom and approvals', async () => {
      const { fp, fan, buyer } = await loadFixture(deployFixture)
      await expect(
        fp.connect(fan)['safeTransferFrom(address,address,uint256)'](fan.address, buyer.address, 1),
      ).to.be.revertedWithCustomError(fp, 'TransfersDisabled')
      await expect(fp.connect(fan).approve(buyer.address, 1)).to.be.revertedWithCustomError(fp, 'ApprovalsDisabled')
      await expect(fp.connect(fan).setApprovalForAll(buyer.address, true)).to.be.revertedWithCustomError(
        fp,
        'ApprovalsDisabled',
      )
    })
  })

  describe('resale', () => {
    it('reverts a listing over the cap', async () => {
      const { fp, fan } = await loadFixture(deployFixture)
      await expect(fp.connect(fan).listForResale(1, MAX_RESALE + 1n)).to.be.revertedWithCustomError(
        fp,
        'PriceAboveCap',
      )
      await expect(fp.connect(fan).listForResale(1, ethers.parseEther('3'))).to.be.revertedWithCustomError(
        fp,
        'PriceAboveCap',
      )
    })

    it('allows a listing exactly at the cap', async () => {
      const { fp, fan } = await loadFixture(deployFixture)
      expect(await fp.maxResalePrice(1)).to.equal(MAX_RESALE)
      await expect(fp.connect(fan).listForResale(1, MAX_RESALE))
        .to.emit(fp, 'TicketListed')
        .withArgs(1, fan.address, MAX_RESALE)
    })


    it('only the ticket owner can list', async () => {
      const { fp, stranger } = await loadFixture(deployFixture)
      await expect(fp.connect(stranger).listForResale(1, FACE)).to.be.revertedWithCustomError(fp, 'NotTicketOwner')
    })

    it('happy path: resale pays the seller and a 2% royalty to the organiser', async () => {
      const { fp, organiser, fan, buyer } = await loadFixture(deployFixture)
      await fp.connect(fan).listForResale(1, MAX_RESALE)
      const royalty = (MAX_RESALE * 2n) / 100n
      const tx = fp.connect(buyer).buyResale(1, { value: MAX_RESALE })
      await expect(tx).to.changeEtherBalances([fan, organiser, buyer], [MAX_RESALE - royalty, royalty, -MAX_RESALE])
      await expect(tx).to.emit(fp, 'TicketResold').withArgs(1, fan.address, buyer.address, MAX_RESALE, royalty)
      expect(await fp.ownerOf(1)).to.equal(buyer.address)
      expect(await fp.listedPrice(1)).to.equal(0n)
    })

    it('buyResale needs the exact price and a listing', async () => {
      const { fp, fan, buyer } = await loadFixture(deployFixture)
      await expect(fp.connect(buyer).buyResale(1, { value: FACE })).to.be.revertedWithCustomError(fp, 'NotListed')
      await fp.connect(fan).listForResale(1, FACE)
      await expect(fp.connect(buyer).buyResale(1, { value: FACE - 1n })).to.be.revertedWithCustomError(
        fp,
        'WrongPayment',
      )
    })

    it('cancelListing removes the listing', async () => {
      const { fp, fan, buyer } = await loadFixture(deployFixture)
      await fp.connect(fan).listForResale(1, FACE)
      await fp.connect(fan).cancelListing(1)
      await expect(fp.connect(buyer).buyResale(1, { value: FACE })).to.be.revertedWithCustomError(fp, 'NotListed')
    })
  })

  describe('organiser-controlled resale cap', () => {
    it('setResaleCap changes the cap and emits ResaleCapChanged(old, new)', async () => {
      const { fp } = await loadFixture(deployFixture)
      await expect(fp.setResaleCap(1, 15)).to.emit(fp, 'ResaleCapChanged').withArgs(1, CAP_PCT, 15)
      expect((await fp.events(1)).resaleCapPct).to.equal(15n)
      expect(await fp.maxResalePrice(1)).to.equal((FACE * 115n) / 100n)
    })

    it('only the owner can change it; it must be 0-100 and the event must exist', async () => {
      const { fp, stranger } = await loadFixture(deployFixture)
      await expect(fp.connect(stranger).setResaleCap(1, 20)).to.be.revertedWithCustomError(fp, 'OwnableUnauthorizedAccount')
      await expect(fp.setResaleCap(1, 101)).to.be.revertedWithCustomError(fp, 'InvalidCap')
      await expect(fp.setResaleCap(99, 5)).to.be.revertedWithCustomError(fp, 'UnknownEvent')
      await expect(fp.createEvent('x', 1, FACE, 1, 101)).to.be.revertedWithCustomError(fp, 'InvalidCap')
      await expect(fp.setResaleCap(1, 100)).to.emit(fp, 'ResaleCapChanged')
    })

    it('cap 0 means resale only at face price', async () => {
      const { fp, fan } = await loadFixture(deployFixture)
      await fp.setResaleCap(1, 0)
      await expect(fp.connect(fan).listForResale(1, FACE + 1n)).to.be.revertedWithCustomError(fp, 'PriceAboveCap')
      await expect(fp.connect(fan).listForResale(1, FACE)).to.emit(fp, 'TicketListed')
    })

    it('raising the cap allows a higher listing', async () => {
      const { fp, fan } = await loadFixture(deployFixture)
      const at15 = (FACE * 115n) / 100n
      await expect(fp.connect(fan).listForResale(1, at15)).to.be.revertedWithCustomError(fp, 'PriceAboveCap')
      await fp.setResaleCap(1, 15)
      await expect(fp.connect(fan).listForResale(1, at15)).to.emit(fp, 'TicketListed')
    })

    it('lowering the cap blocks buying an existing listing above the new cap; raising it again unblocks it', async () => {
      const { fp, fan, buyer } = await loadFixture(deployFixture)
      await fp.connect(fan).listForResale(1, MAX_RESALE) // +10%, valid when listed
      await fp.setResaleCap(1, 5)
      await expect(fp.connect(buyer).buyResale(1, { value: MAX_RESALE }))
        .to.be.revertedWithCustomError(fp, 'PriceAboveCap')
        .withArgs(MAX_RESALE, (FACE * 105n) / 100n)
      expect(await fp.ownerOf(1)).to.equal(fan.address)
      await fp.setResaleCap(1, 10)
      await fp.connect(buyer).buyResale(1, { value: MAX_RESALE })
      expect(await fp.ownerOf(1)).to.equal(buyer.address)
    })
  })

  describe('return to pool', () => {
    it('return to pool + reassign moves the ticket to the waitlisted fan', async () => {
      const { fp, organiser, fan, waitlisted } = await loadFixture(deployFixture)
      await fp.connect(fan).listForResale(1, FACE)
      await expect(fp.connect(fan).returnToPool(1)).to.emit(fp, 'TicketReturned').withArgs(1, fan.address)
      expect(await fp.ownerOf(1)).to.equal(organiser.address)
      expect(await fp.listedPrice(1)).to.equal(0n) // listing cleared on transfer
      await expect(fp.reassign(1, waitlisted.address)).to.emit(fp, 'TicketReassigned').withArgs(1, waitlisted.address)
      expect(await fp.ownerOf(1)).to.equal(waitlisted.address)
    })


    it('reassign only works for pooled tickets and only for the owner', async () => {
      const { fp, fan, waitlisted, stranger } = await loadFixture(deployFixture)
      await expect(fp.reassign(1, waitlisted.address)).to.be.revertedWithCustomError(fp, 'NotInPool')
      await fp.connect(fan).returnToPool(1)
      await expect(fp.connect(stranger).reassign(1, stranger.address)).to.be.revertedWithCustomError(
        fp,
        'OwnableUnauthorizedAccount',
      )
    })
  })

  describe('gate', () => {
    it('markUsed twice reverts', async () => {
      const { fp, staff } = await loadFixture(deployFixture)
      await expect(fp.connect(staff).markUsed(1)).to.emit(fp, 'TicketUsed').withArgs(1, staff.address)
      expect(await fp.isValid(1)).to.equal(false)
      await expect(fp.connect(staff).markUsed(1)).to.be.revertedWithCustomError(fp, 'TicketAlreadyUsed')
    })

    it('non-staff markUsed reverts', async () => {
      const { fp, fan } = await loadFixture(deployFixture)
      await expect(fp.connect(fan).markUsed(1)).to.be.revertedWithCustomError(fp, 'NotGateStaff')
    })

    it('a never-minted token is not valid and cannot be marked used', async () => {
      const { fp, staff } = await loadFixture(deployFixture)
      expect(await fp.isValid(999)).to.equal(false)
      await expect(fp.connect(staff).markUsed(999)).to.be.revertedWithCustomError(fp, 'ERC721NonexistentToken')
    })

    it('a used ticket cannot be listed or returned', async () => {
      const { fp, fan, staff } = await loadFixture(deployFixture)
      await fp.connect(staff).markUsed(1)
      await expect(fp.connect(fan).listForResale(1, FACE)).to.be.revertedWithCustomError(fp, 'TicketAlreadyUsed')
      await expect(fp.connect(fan).returnToPool(1)).to.be.revertedWithCustomError(fp, 'TicketAlreadyUsed')
    })
  })
})
