<?php

declare(strict_types=1);

namespace App;

class GradeCalculator
{
    private const WEIGHTS = [
        'quiz' => 0.20,
        'assignment' => 0.20,
        'midterm' => 0.25,
        'final' => 0.35,
    ];

    private const LETTER_GRADES = [
        ['min' => 98, 'grade' => 'A+'],
        ['min' => 92, 'grade' => 'A'],
        ['min' => 90, 'grade' => 'A-'],
        ['min' => 88, 'grade' => 'B+'],
        ['min' => 84, 'grade' => 'B'],
        ['min' => 80, 'grade' => 'B-'],
        ['min' => 77, 'grade' => 'C+'],
        ['min' => 73, 'grade' => 'C'],
        ['min' => 70, 'grade' => 'C-'],
        ['min' => 60, 'grade' => 'D'],
    ];

    public function __construct(
        private readonly float $quiz,
        private readonly float $assignment,
        private readonly float $midterm,
        private readonly float $final,
    ) {}

    public function getWeightedScores(): array
    {
        $scores = [
            'quiz' => $this->quiz,
            'assignment' => $this->assignment,
            'midterm' => $this->midterm,
            'final' => $this->final,
        ];

        return array_combine(
            array_keys($scores),
            array_map(fn($score, $weight) => $score * $weight, $scores, self::WEIGHTS),
        );
    }

    public function getFinalGrade(): float
    {
        return array_sum($this->getWeightedScores());
    }

    public function getLetterGrade(): string
    {
        $grade = $this->getFinalGrade();

        foreach (self::LETTER_GRADES as $tier) {
            if ($grade >= $tier['min']) {
                return $tier['grade'];
            }
        }

        return 'F';
    }

    public function getRemarks(): string
    {
        return match (true) {
            $this->getFinalGrade() >= 90 => 'Excellent',
            $this->getFinalGrade() >= 80 => 'Good',
            $this->getFinalGrade() >= 70 => 'Fair',
            $this->getFinalGrade() >= 60 => 'Passed',
            default => 'Failed',
        };
    }

    public function isPassed(): bool
    {
        return $this->getFinalGrade() >= 60;
    }
}
