// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

// 只声明我们要用的三个函数。Escrow 通过这个接口去调用任何 ERC20 合约。
interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract Escrow {
    // -------- 状态机 --------
    enum Status { Created, Paid, Completed, Refunded, Disputed }

    struct Order {
        address buyer;
        address seller;
        address token;      // 用哪种 ERC20 结算
        uint256 amount;     // 最小单位
        uint256 deadline;   // unix 时间戳，秒
        Status status;
        string description;
    }

    // -------- 存储 --------
    address public arbiter;
    uint256 public orderCount;
    mapping(uint256 => Order) private _orders;

    // -------- 事件 --------
    event OrderCreated(
        uint256 indexed id,
        address indexed buyer,
        address indexed seller,
        address token,
        uint256 amount,
        uint256 deadline
    );
    event OrderPaid(uint256 indexed id);
    event OrderCompleted(uint256 indexed id);
    event OrderRefunded(uint256 indexed id);
    event OrderDisputed(uint256 indexed id, address by);
    event OrderResolved(uint256 indexed id, bool sellerWins);

    // -------- 修饰器 --------
    modifier onlyArbiter() {
        require(msg.sender == arbiter, "Escrow: caller is not the arbiter");
        _;
    }

    modifier onlyBuyer(uint256 id) {
        require(msg.sender == _orders[id].buyer, "Escrow: caller is not the buyer");
        _;
    }

    modifier inStatus(uint256 id, Status s) {
        require(_orders[id].status == s, "Escrow: wrong status");
        _;
    }

    constructor(address _arbiter) {
        require(_arbiter != address(0), "Escrow: arbiter is the zero address");
        arbiter = _arbiter;
    }

    function getOrder(uint256 id) public view returns (Order memory) {
        require(id < orderCount, "Escrow: order does not exist");
        return _orders[id];
    }

    // -------- TODO 1: 创建订单 --------
    // 要求：seller 不能是零地址、不能是自己；amount 大于 0；deadline 必须在未来；
    // 订单 id 为当前 orderCount，写入 _orders，orderCount 加一；
    // buyer 是 msg.sender，状态 Created；发出 OrderCreated；返回 id。
    function createOrder(
        address seller,
        address token,
        uint256 amount,
        uint256 deadline,
        string memory description
    ) public returns (uint256) {
        require(seller != address(0), "Escrow: seller is the zero address");
        require(seller != msg.sender, "Escrow: seller is the buyer");
        require(amount > 0, "Escrow: amount must be positive");
        require(deadline > block.timestamp, "Escrow: deadline in the past");

        uint256 id = orderCount;
        _orders[id] = Order({
            buyer: msg.sender,
            seller: seller,
            token: token,
            amount: amount,
            deadline: deadline,
            status: Status.Created,
            description: description
        });
        orderCount++;

        emit OrderCreated(id, msg.sender, seller, token, amount, deadline);
        return id;
    }

    // -------- TODO 2: 买家付款 --------
    // 要求：只有买家、只在 Created 状态（用修饰器）；
    // 先把状态改为 Paid，再调用代币的 transferFrom
    // 把 amount 从买家转到本合约（address(this)）；
    // transferFrom 返回 false 要 revert；发出 OrderPaid。
    // 提示：IERC20(o.token).transferFrom(...)。想清楚代币合约看到的 msg.sender 是谁。
    function deposit(uint256 id) public onlyBuyer(id) inStatus(id, Status.Created) {
        Order storage o = _orders[id];

        // 先改状态，再调用外部合约（防重入）
        o.status = Status.Paid;

        bool ok = IERC20(o.token).transferFrom(msg.sender, address(this), o.amount);
        require(ok, "Escrow: token transfer failed");

        emit OrderPaid(id);
    }

    // -------- TODO 3: 买家确认收货 --------
    // 要求：只有买家、只在 Paid 状态；
    // 状态改为 Completed；代币转给卖家；发出 OrderCompleted。
    function confirm(uint256 id) public {
        Order storage o = _orders[id];

        require(msg.sender == o.buyer, "Escrow: caller is not the buyer");
        require(o.status == Status.Paid, "Escrow: wrong status");

        o.status = Status.Completed;

        bool ok = IERC20(o.token).transfer(o.seller, o.amount);
        require(ok, "Escrow: token transfer failed");

        emit OrderCompleted(id);
    }

    // -------- TODO 4: 超期退款 --------
    // 要求：只有买家、只在 Paid 状态；block.timestamp 必须大于 deadline；
    // 状态改为 Refunded；代币退回买家；发出 OrderRefunded。
    function refund(uint256 id) public {
        Order storage o = _orders[id];

        require(msg.sender == o.buyer, "Escrow: caller is not the buyer");
        require(o.status == Status.Paid, "Escrow: wrong status");
        require(block.timestamp > o.deadline, "Escrow: deadline not reached");

        o.status = Status.Refunded;

        bool ok = IERC20(o.token).transfer(o.buyer, o.amount);
        require(ok, "Escrow: token transfer failed");

        emit OrderRefunded(id);
    }

    // -------- TODO 5: 发起争议 --------
    // 要求：只在 Paid 状态；调用者必须是买家或卖家；
    // 状态改为 Disputed；发出 OrderDisputed。
    function dispute(uint256 id) public {
        Order storage o = _orders[id];

        require(
            msg.sender == o.buyer || msg.sender == o.seller,
            "Escrow: caller is not a party"
        );
        require(o.status == Status.Paid, "Escrow: wrong status");

        o.status = Status.Disputed;

        emit OrderDisputed(id, msg.sender);
    }

    // -------- TODO 6: 仲裁 --------
    // 要求：只有仲裁人、只在 Disputed 状态；
    // sellerWins 为 true 则状态 Completed、代币给卖家，
    // 否则状态 Refunded、代币退买家；
    // 发出 OrderResolved。
    function resolve(uint256 id, bool sellerWins) public {
        Order storage o = _orders[id];

        require(msg.sender == arbiter, "Escrow: caller is not the arbiter");
        require(o.status == Status.Disputed, "Escrow: wrong status");

        if (sellerWins) {
            o.status = Status.Completed;
            bool ok = IERC20(o.token).transfer(o.seller, o.amount);
            require(ok, "Escrow: token transfer failed");
        } else {
            o.status = Status.Refunded;
            bool ok = IERC20(o.token).transfer(o.buyer, o.amount);
            require(ok, "Escrow: token transfer failed");
        }

        emit OrderResolved(id, sellerWins);
    }
}
