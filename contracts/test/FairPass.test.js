// Unit tests run on Hardhat's in-process network with hre.ethers (the only place ethers is used).
const { expect } = require('chai')
const { ethers } = require('hardhat')
const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers')

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
      await expect(fp.connect(fan).listForResale(1, MAX_RESALE + 1n, ethers.ZeroAddress)).to.be.revertedWithCustomError(
        fp,
        'PriceAboveCap',
      )
      await expect(fp.connect(fan).listForResale(1, ethers.parseEther('3'), ethers.ZeroAddress)).to.be.revertedWithCustomError(
        fp,
        'PriceAboveCap',
      )
    })

    it('allows a listing exactly at the cap', async () => {
      const { fp, fan } = await loadFixture(deployFixture)
      expect(await fp.maxResalePrice(1)).to.equal(MAX_RESALE)
      await expect(fp.connect(fan).listForResale(1, MAX_RESALE, ethers.ZeroAddress))
        .to.emit(fp, 'TicketListed')
        .withArgs(1, fan.address, MAX_RESALE, ethers.ZeroAddress)
    })


    it('only the ticket owner can list', async () => {
      const { fp, stranger } = await loadFixture(deployFixture)
      await expect(fp.connect(stranger).listForResale(1, FACE, ethers.ZeroAddress)).to.be.revertedWithCustomError(fp, 'NotTicketOwner')
    })

    it('happy path: resale pays the seller and a 2% royalty to the organiser', async () => {
      const { fp, organiser, fan, buyer } = await loadFixture(deployFixture)
      await fp.connect(fan).listForResale(1, MAX_RESALE, ethers.ZeroAddress)
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
      await fp.connect(fan).listForResale(1, FACE, ethers.ZeroAddress)
      await expect(fp.connect(buyer).buyResale(1, { value: FACE - 1n })).to.be.revertedWithCustomError(
        fp,
        'WrongPayment',
      )
    })

    it('cancelListing removes the listing', async () => {
      const { fp, fan, buyer } = await loadFixture(deployFixture)
      await fp.connect(fan).listForResale(1, FACE, ethers.ZeroAddress)
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
      await expect(fp.connect(fan).listForResale(1, FACE + 1n, ethers.ZeroAddress)).to.be.revertedWithCustomError(fp, 'PriceAboveCap')
      await expect(fp.connect(fan).listForResale(1, FACE, ethers.ZeroAddress)).to.emit(fp, 'TicketListed')
    })

    it('raising the cap allows a higher listing', async () => {
      const { fp, fan } = await loadFixture(deployFixture)
      const at15 = (FACE * 115n) / 100n
      await expect(fp.connect(fan).listForResale(1, at15, ethers.ZeroAddress)).to.be.revertedWithCustomError(fp, 'PriceAboveCap')
      await fp.setResaleCap(1, 15)
      await expect(fp.connect(fan).listForResale(1, at15, ethers.ZeroAddress)).to.emit(fp, 'TicketListed')
    })

    it('lowering the cap blocks buying an existing listing above the new cap; raising it again unblocks it', async () => {
      const { fp, fan, buyer } = await loadFixture(deployFixture)
      await fp.connect(fan).listForResale(1, MAX_RESALE, ethers.ZeroAddress) // +10%, valid when listed
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

  describe('public and private resale', () => {
    it('public listing: anyone can buy at the listed price', async () => {
      const { fp, fan, buyer } = await loadFixture(deployFixture)
      await fp.connect(fan).listForResale(1, MAX_RESALE, ethers.ZeroAddress)
      await fp.connect(buyer).buyResale(1, { value: MAX_RESALE })
      expect(await fp.ownerOf(1)).to.equal(buyer.address)
    })

    it('private listing: only the chosen buyer can buy; the seller is paid minus 2%', async () => {
      const { fp, fan, buyer, stranger } = await loadFixture(deployFixture)
      await expect(fp.connect(fan).listForResale(1, FACE, buyer.address))
        .to.emit(fp, 'TicketListed')
        .withArgs(1, fan.address, FACE, buyer.address)
      await expect(fp.connect(stranger).buyResale(1, { value: FACE })).to.be.revertedWithCustomError(fp, 'NotAllowedBuyer')
      const tx = fp.connect(buyer).buyResale(1, { value: FACE })
      await expect(tx).to.changeEtherBalance(fan, FACE - (FACE * 2n) / 100n)
      expect(await fp.ownerOf(1)).to.equal(buyer.address)
      expect(await fp.allowedBuyer(1)).to.equal(ethers.ZeroAddress) // cleared on sale
    })

    it('over-cap listing fails for public and private listings', async () => {
      const { fp, fan, buyer } = await loadFixture(deployFixture)
      await expect(fp.connect(fan).listForResale(1, MAX_RESALE + 1n, ethers.ZeroAddress)).to.be.revertedWithCustomError(fp, 'PriceAboveCap')
      await expect(fp.connect(fan).listForResale(1, MAX_RESALE + 1n, buyer.address)).to.be.revertedWithCustomError(fp, 'PriceAboveCap')
    })

    it('buying a private listing after the cap was lowered fails', async () => {
      const { fp, fan, buyer } = await loadFixture(deployFixture)
      await fp.connect(fan).listForResale(1, MAX_RESALE, buyer.address)
      await fp.setResaleCap(1, 0)
      await expect(fp.connect(buyer).buyResale(1, { value: MAX_RESALE })).to.be.revertedWithCustomError(fp, 'PriceAboveCap')
    })

    it('a seller cannot make a private listing for themselves', async () => {
      const { fp, fan } = await loadFixture(deployFixture)
      await expect(fp.connect(fan).listForResale(1, FACE, fan.address)).to.be.revertedWithCustomError(fp, 'InvalidAddress')
    })

    it('cancelling clears the price and the allowed buyer (ListingCancelled)', async () => {
      const { fp, fan, buyer } = await loadFixture(deployFixture)
      await fp.connect(fan).listForResale(1, FACE, buyer.address)
      await expect(fp.connect(fan).cancelListing(1)).to.emit(fp, 'ListingCancelled').withArgs(1)
      expect(await fp.listedPrice(1)).to.equal(0n)
      expect(await fp.allowedBuyer(1)).to.equal(ethers.ZeroAddress)
    })
  })

  describe('gifts', () => {
    it('gift happy path: free transfer, TicketGifted, marked gifted', async () => {
      const { fp, fan, buyer } = await loadFixture(deployFixture)
      await expect(fp.connect(fan).giftTicket(1, buyer.address)).to.emit(fp, 'TicketGifted').withArgs(1, fan.address, buyer.address)
      expect(await fp.ownerOf(1)).to.equal(buyer.address)
      expect(await fp.gifted(1)).to.equal(true)
    })

    it('a second gift of the same ticket fails', async () => {
      const { fp, fan, buyer, stranger } = await loadFixture(deployFixture)
      await fp.connect(fan).giftTicket(1, buyer.address)
      await expect(fp.connect(buyer).giftTicket(1, stranger.address)).to.be.revertedWithCustomError(fp, 'AlreadyGifted')
    })

    it('gifting to yourself or to nobody fails; only the owner can gift', async () => {
      const { fp, fan, buyer } = await loadFixture(deployFixture)
      await expect(fp.connect(fan).giftTicket(1, fan.address)).to.be.revertedWithCustomError(fp, 'InvalidAddress')
      await expect(fp.connect(fan).giftTicket(1, ethers.ZeroAddress)).to.be.revertedWithCustomError(fp, 'InvalidAddress')
      await expect(fp.connect(buyer).giftTicket(1, buyer.address)).to.be.revertedWithCustomError(fp, 'NotTicketOwner')
    })

    it('a listed or used ticket cannot be gifted', async () => {
      const { fp, fan, buyer, staff } = await loadFixture(deployFixture)
      await fp.connect(fan).listForResale(1, FACE, ethers.ZeroAddress)
      await expect(fp.connect(fan).giftTicket(1, buyer.address)).to.be.revertedWithCustomError(fp, 'TicketIsListed')
      await fp.connect(staff).markUsed(2)
      await expect(fp.connect(fan).giftTicket(2, buyer.address)).to.be.revertedWithCustomError(fp, 'TicketAlreadyUsed')
    })

    it('a gifted ticket can still be returned to the pool (only gifting is once)', async () => {
      const { fp, organiser, fan, buyer } = await loadFixture(deployFixture)
      await fp.connect(fan).giftTicket(1, buyer.address)
      await fp.connect(buyer).returnToPool(1)
      expect(await fp.ownerOf(1)).to.equal(organiser.address)
    })
  })

  describe('24 h transfer lock', () => {
    it('gifts, listings and purchases fail inside the last 24 h; return and cancel still work', async () => {
      const { fp, organiser, fan, buyer } = await loadFixture(deployFixture)
      await fp.connect(fan).listForResale(1, FACE, ethers.ZeroAddress) // listed before the lock
      const event = await fp.events(1)
      await time.increaseTo(event.date - 23n * 3600n) // 23 h before the show
      await expect(fp.connect(buyer).buyResale(1, { value: FACE })).to.be.revertedWithCustomError(fp, 'TransfersLocked')
      await expect(fp.connect(fan).giftTicket(2, buyer.address)).to.be.revertedWithCustomError(fp, 'TransfersLocked')
      await expect(fp.connect(fan).listForResale(2, FACE, ethers.ZeroAddress)).to.be.revertedWithCustomError(fp, 'TransfersLocked')
      await fp.connect(fan).cancelListing(1)
      await fp.connect(fan).returnToPool(2)
      expect(await fp.ownerOf(2)).to.equal(organiser.address)
    })

    it('just outside the lock (25 h before) transfers still work', async () => {
      const { fp, fan, buyer } = await loadFixture(deployFixture)
      const event = await fp.events(1)
      await time.increaseTo(event.date - 25n * 3600n)
      await fp.connect(fan).giftTicket(1, buyer.address)
      expect(await fp.ownerOf(1)).to.equal(buyer.address)
    })
  })

  describe('return to pool', () => {
    it('return to pool + reassign moves the ticket to the waitlisted fan', async () => {
      const { fp, organiser, fan, waitlisted } = await loadFixture(deployFixture)
      await fp.connect(fan).listForResale(1, FACE, ethers.ZeroAddress)
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

    it('a listed ticket cannot be checked in until the listing is cancelled', async () => {
      const { fp, fan, staff } = await loadFixture(deployFixture)
      await fp.connect(fan).listForResale(1, FACE, ethers.ZeroAddress)
      await expect(fp.connect(staff).markUsed(1)).to.be.revertedWithCustomError(fp, 'TicketIsListed')
      await fp.connect(fan).cancelListing(1)
      await expect(fp.connect(staff).markUsed(1)).to.emit(fp, 'TicketUsed')
    })

    it('a used ticket cannot be listed or returned', async () => {
      const { fp, fan, staff } = await loadFixture(deployFixture)
      await fp.connect(staff).markUsed(1)
      await expect(fp.connect(fan).listForResale(1, FACE, ethers.ZeroAddress)).to.be.revertedWithCustomError(fp, 'TicketAlreadyUsed')
      await expect(fp.connect(fan).returnToPool(1)).to.be.revertedWithCustomError(fp, 'TicketAlreadyUsed')
    })
  })
})
