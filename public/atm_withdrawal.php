<?php

session_start();

// Initialize balance on first visit
if (!isset($_SESSION['balance'])) {
    $_SESSION['balance'] = 5000.00;
}

$balance = $_SESSION['balance'];
$message = '';
$isPinValid = false;
$withdrawn = null;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $pin = isset($_POST['pin']) ? (int)$_POST['pin'] : 0;
    $amount = isset($_POST['amount']) ? (float)$_POST['amount'] : 0.00;
    $action = isset($_POST['action']) ? $_POST['action'] : '';

    if ($action === 'verify') {
        // Step 1: Verify PIN only
        if ($pin !== 1234) {
            $message = 'Access Denied. Incorrect PIN.';
        } else {
            $isPinValid = true;
        }
    } elseif ($action === 'withdraw') {
        // Step 2: PIN already verified, validate amount
        $isPinValid = true;

        if ($amount < 100) {
            $message = 'Please enter a valid withdrawal amount minimum of ₱100.';
        } elseif ($amount > $balance) {
            $message = 'Insufficient Funds!';
        } else {
            // Step 3: Process withdrawal
            $balance = $balance - $amount;
            $_SESSION['balance'] = $balance;
            $withdrawn = $amount;
            $message = 'Withdrawal Successful!';
        }
    }
} else {
    $pin = '';
    $amount = 0.00;
}

?>


<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ATM Withdrawal</title>
</head>

<body>

    <form action="atm_withdrawal.php" method="post">

        <?php if (!$isPinValid): ?>
            <div>
                <input type="number" name="pin" placeholder="Enter PIN"
                    value="<?php echo htmlspecialchars($pin); ?>">
                <button type="submit" name="action" value="verify">Verify PIN</button>
            </div>
        <?php endif; ?>

        <?php if ($isPinValid): ?>
            <div>
                <input type="number" name="amount" placeholder="Enter amount"
                    value="<?php echo htmlspecialchars($amount ?? 0.00); ?>">
                <input type="hidden" name="pin" value="<?php echo $pin; ?>">
                <button type="submit" name="action" value="withdraw">Withdraw</button>
            </div>
        <?php endif; ?>

    </form>

    <?php if ($message): ?>
        <p><strong><?php echo $message; ?></strong></p>
    <?php endif; ?>

    <?php if (isset($withdrawn)): ?>
        <p>Amount Withdrawn: ₱<?php echo number_format($withdrawn, 2); ?></p>
        <p>Remaining Balance: ₱<?php echo number_format($balance, 2); ?></p>
    <?php endif; ?>

</body>

</html>