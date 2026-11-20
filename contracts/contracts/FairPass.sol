// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title FairPass - concert tickets as NFTs that can only move through this contract.
/// @notice Fair resale (price cap), return-to-pool, and one-time gate check-in.
///         Only the contract owner (the organiser) mints. Plain transfers and approvals are disabled.
contract FairPass is ERC721, Ownable, ReentrancyGuard {
    struct Event {
        string name;
        uint256 date; // unix seconds
        uint256 facePrice; // wei (QUAI has 18 decimals)
        uint32 maxSupply;
        uint32 minted;
        uint8 resaleCapPct; // e.g. 10 => resale price <= face * 110%
        address organiser; // receives the resale royalty
    }

    uint256 public constant ROYALTY_PCT = 2;
    uint8 public constant MAX_RESALE_CAP_PCT = 100;
    uint32 public constant MAX_MINT_BATCH = 100;

    uint256 public nextEventId = 1;
    uint256 public nextTokenId = 1;

    mapping(uint256 => Event) public events;
    mapping(uint256 => uint256) public ticketEvent; // tokenId => eventId
    mapping(uint256 => bool) public used; // tokenId => checked in at the gate
    mapping(uint256 => uint256) public listedPrice; // tokenId => resale price (0 = not listed)
    mapping(address => bool) public gateStaff;

    /// @dev True only while one of the allowed transfer paths is running.
    bool private _transferAllowed;

    event EventCreated(uint256 indexed eventId, string name, uint256 date, uint256 facePrice, uint32 maxSupply, uint8 resaleCapPct);
    event TicketMinted(uint256 indexed tokenId, uint256 indexed eventId, address indexed to);
    event ResaleCapChanged(uint256 indexed eventId, uint8 oldPct, uint8 newPct);
    event TicketListed(uint256 indexed tokenId, address indexed seller, uint256 price);
    event TicketListingCancelled(uint256 indexed tokenId);
    event TicketResold(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price, uint256 royalty);
    event TicketReturned(uint256 indexed tokenId, address indexed from);
    event TicketReassigned(uint256 indexed tokenId, address indexed to);
    event TicketUsed(uint256 indexed tokenId, address indexed staff);
    event GateStaffSet(address indexed staff, bool allowed);

    error TransfersDisabled();
    error ApprovalsDisabled();
    error UnknownEvent();
    error SoldOut();
    error NotTicketOwner();
    error NotGateStaff();
    error InvalidCap();
    error InvalidQuantity();
    error TicketAlreadyUsed();
    error PriceAboveCap(uint256 price, uint256 maxPrice);
    error InvalidPrice();
    error NotListed();
    error WrongPayment(uint256 sent, uint256 expected);
    error NotInPool();
    error InvalidAddress();
    error PaymentFailed();

    modifier onlyGateStaff() {
        if (!gateStaff[msg.sender]) revert NotGateStaff();
        _;
    }

    modifier onlyTicketOwner(uint256 tokenId) {
        if (ownerOf(tokenId) != msg.sender) revert NotTicketOwner();
        _;
    }

    /// @dev Opens the transfer gate for exactly one allowed operation.
    modifier allowTransfer() {
        _transferAllowed = true;
        _;
        _transferAllowed = false;
    }

    constructor(string memory name_, string memory symbol_) ERC721(name_, symbol_) Ownable(msg.sender) {}

    // ------------------------------------------------------------------ organiser

    function createEvent(
        string calldata name,
        uint256 date,
        uint256 facePrice,
        uint32 maxSupply,
        uint8 resaleCapPct
    ) external onlyOwner returns (uint256 eventId) {
        if (maxSupply == 0 || facePrice == 0) revert InvalidPrice();
        if (resaleCapPct > MAX_RESALE_CAP_PCT) revert InvalidCap();
        eventId = nextEventId++;
        events[eventId] = Event(name, date, facePrice, maxSupply, 0, resaleCapPct, msg.sender);
        emit EventCreated(eventId, name, date, facePrice, maxSupply, resaleCapPct);
    }

    function mintTicket(address to, uint256 eventId) external onlyOwner returns (uint256 tokenId) {
        return _mintBatch(to, eventId, 1);
    }

    /// @notice Mints `quantity` tickets for one winner in a single transaction. Returns the first token id
    ///         (the rest follow consecutively).
    function mintTickets(address to, uint256 eventId, uint32 quantity) external onlyOwner returns (uint256 firstTokenId) {
        if (quantity == 0 || quantity > MAX_MINT_BATCH) revert InvalidQuantity();
        return _mintBatch(to, eventId, quantity);
    }

    function _mintBatch(address to, uint256 eventId, uint32 quantity) private returns (uint256 firstTokenId) {
        Event storage e = events[eventId];
        if (e.maxSupply == 0) revert UnknownEvent();
        if (uint256(e.minted) + quantity > e.maxSupply) revert SoldOut();
        e.minted += quantity;
        firstTokenId = nextTokenId;
        for (uint32 i = 0; i < quantity; i++) {
            uint256 tokenId = nextTokenId++;
            ticketEvent[tokenId] = eventId;
            _safeMint(to, tokenId);
            emit TicketMinted(tokenId, eventId, to);
        }
    }

    /// @notice Organiser changes how far above face price this event's tickets may be resold (0 = face price only).
    ///         Applies immediately, including to existing listings: buyResale re-checks the current cap.
    function setResaleCap(uint256 eventId, uint8 newPct) external onlyOwner {
        Event storage e = events[eventId];
        if (e.maxSupply == 0) revert UnknownEvent();
        if (newPct > MAX_RESALE_CAP_PCT) revert InvalidCap();
        uint8 oldPct = e.resaleCapPct;
        e.resaleCapPct = newPct;
        emit ResaleCapChanged(eventId, oldPct, newPct);
    }

    function addGateStaff(address staff) external onlyOwner {
        if (staff == address(0)) revert InvalidAddress();
        gateStaff[staff] = true;
        emit GateStaffSet(staff, true);
    }

    function removeGateStaff(address staff) external onlyOwner {
        gateStaff[staff] = false;
        emit GateStaffSet(staff, false);
    }

    /// @notice Organiser gives a pooled ticket to the next waitlisted fan (or a swapped employee).
    function reassign(uint256 tokenId, address to) external onlyOwner allowTransfer {
        if (to == address(0)) revert InvalidAddress();
        if (ownerOf(tokenId) != owner()) revert NotInPool();
        if (used[tokenId]) revert TicketAlreadyUsed();
        _transfer(owner(), to, tokenId);
        emit TicketReassigned(tokenId, to);
    }

    // ------------------------------------------------------------------ resale

    /// @notice The highest price this ticket may be resold for.
    function maxResalePrice(uint256 tokenId) public view returns (uint256) {
        Event storage e = events[ticketEvent[tokenId]];
        return (e.facePrice * (100 + uint256(e.resaleCapPct))) / 100;
    }

    function listForResale(uint256 tokenId, uint256 price) external onlyTicketOwner(tokenId) {
        if (used[tokenId]) revert TicketAlreadyUsed();
        if (price == 0) revert InvalidPrice();
        uint256 cap = maxResalePrice(tokenId);
        if (price > cap) revert PriceAboveCap(price, cap);
        listedPrice[tokenId] = price;
        emit TicketListed(tokenId, msg.sender, price);
    }

    function cancelListing(uint256 tokenId) external onlyTicketOwner(tokenId) {
        if (listedPrice[tokenId] == 0) revert NotListed();
        delete listedPrice[tokenId];
        emit TicketListingCancelled(tokenId);
    }

    /// @notice Buy a listed ticket at exactly its listed price. The seller gets the price minus a 2% organiser royalty.
    ///         The price is re-checked against the CURRENT cap, so lowering the cap blocks listings above it.
    function buyResale(uint256 tokenId) external payable nonReentrant allowTransfer {
        uint256 price = listedPrice[tokenId];
        if (price == 0) revert NotListed();
        if (msg.value != price) revert WrongPayment(msg.value, price);
        if (used[tokenId]) revert TicketAlreadyUsed();
        uint256 cap = maxResalePrice(tokenId);
        if (price > cap) revert PriceAboveCap(price, cap);
        address seller = ownerOf(tokenId);
        if (seller == msg.sender) revert InvalidAddress();

        uint256 royalty = (price * ROYALTY_PCT) / 100;
        address organiser = events[ticketEvent[tokenId]].organiser;

        _transfer(seller, msg.sender, tokenId); // also clears the listing in _update
        emit TicketResold(tokenId, seller, msg.sender, price, royalty);

        _pay(seller, price - royalty);
        _pay(organiser, royalty);
    }

    /// @notice Give the ticket back to the organiser's pool. The face-price refund is handled off-chain (mocked).
    function returnToPool(uint256 tokenId) external onlyTicketOwner(tokenId) allowTransfer {
        if (used[tokenId]) revert TicketAlreadyUsed();
        if (msg.sender == owner()) revert NotInPool();
        _transfer(msg.sender, owner(), tokenId);
        emit TicketReturned(tokenId, msg.sender);
    }

    // ------------------------------------------------------------------ gate

    function markUsed(uint256 tokenId) external onlyGateStaff {
        _requireOwned(tokenId); // reverts for tokens that were never minted
        if (used[tokenId]) revert TicketAlreadyUsed();
        used[tokenId] = true;
        delete listedPrice[tokenId];
        emit TicketUsed(tokenId, msg.sender);
    }

    /// @notice A ticket is valid if this contract minted it and it hasn't been used.
    function isValid(uint256 tokenId) external view returns (bool) {
        return _ownerOf(tokenId) != address(0) && !used[tokenId];
    }

    // ------------------------------------------------------------------ transfer lock

    /// @dev OZ v5 hook for every mint/transfer/burn. Only mints and the allowed paths above may move tokens.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && !_transferAllowed) revert TransfersDisabled();
        if (from != address(0)) delete listedPrice[tokenId];
        return super._update(to, tokenId, auth);
    }

    function approve(address, uint256) public pure override {
        revert ApprovalsDisabled();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert ApprovalsDisabled();
    }

    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert PaymentFailed();
    }
}
