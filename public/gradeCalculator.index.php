<?php

use App\GradeCalculator;

$calculator = new GradeCalculator(
    quiz: (float)($_POST['quiz_score'] ?? 0),
    assignment: (float)($_POST['assignment_score'] ?? 0),
    midterm: (float)($_POST['midterm_exam'] ?? 0),
    final: (float)($_POST['final_exam'] ?? 0),
);
?>
<!DOCTYPE html>
<html>

<head>
    <title>Grade Calculator with Letter</title>
</head>

<body>
    <div style="max-width: 600px; margin: 50px auto; padding: 10px; border: 1px solid #ccc; border-radius: 10px;">
        <h2 style="text-align: center;">Grade Calculator with Letter</h2>

        <div style="text-align: center;">
            <form method="post">
                <label>Quiz Score (0-100)</label>
                <input type="number" name="quiz_score"> <br><br>
                <label>Assignment Score (0-100)</label>
                <input type="number" name="assignment_score"> <br><br>
                <label>Midterm Exam(0-100)</label>
                <input type="number" name="midterm_exam"> <br><br>
                <label>Final Exam(0-100)</label>
                <input type="number" name="final_exam"> <br><br>
                <button type="submit" style="border: none; background-color: #007bff; color: white; padding: 10px 20px; border-radius: 5px; cursor: pointer;">Calculate Grade</button>
            </form>
        </div>

        <?php if ($_SERVER['REQUEST_METHOD'] === 'POST'): ?>
            <?php $weighted = $calculator->getWeightedScores(); ?>
            <div style="text-align: center; border: 1px solid #ccc; padding: 10px; border-radius: 5px; margin-top: 10px;">
                <h3>Results</h3>
                <p>Quiz (20%): <?php echo number_format($weighted['quiz'], 2); ?></p>
                <p>Assignment (20%): <?php echo number_format($weighted['assignment'], 2); ?></p>
                <p>Midterm (25%): <?php echo number_format($weighted['midterm'], 2); ?></p>
                <p>Final (35%): <?php echo number_format($weighted['final'], 2); ?></p>
            </div>

            <div style="text-align: center; border: 1px solid #ccc; padding: 10px; border-radius: 5px; margin-top: 10px;">
                <p>Final Grade: <?php echo number_format($calculator->getFinalGrade(), 2); ?>%</p>
                <p>Letter Grade: <?php echo $calculator->getLetterGrade(); ?></p>
                <p>Remarks: <?php echo $calculator->getRemarks(); ?></p>
                <p>Status: <?php echo $calculator->isPassed() ? 'Passed' : 'Failed'; ?></p>
            </div>
        <?php endif; ?>
    </div>
</body>

</html>